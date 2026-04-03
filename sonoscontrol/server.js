const express = require('express');
const { execFile } = require('child_process');
const { parseString } = require('xml2js');
const path = require('path');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const SEED_SPEAKER = process.env.SONOS_IP || '192.168.1.64';
const CURL = os.platform() === 'darwin' ? '/usr/bin/curl' : 'curl';

// House zone — speakers that should group together (Patio excluded)
const HOUSE_SPEAKERS = ['Kitchen', 'One', 'Family Room'];

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Async curl wrapper — non-blocking, allows parallel requests
function curlPost(ip, urlPath, soapAction, body) {
  return new Promise((resolve) => {
    execFile(CURL, [
      '-s', '--connect-timeout', '3',
      '-X', 'POST',
      `http://${ip}:1400${urlPath}`,
      '-H', 'Content-Type: text/xml; charset="utf-8"',
      '-H', `SOAPAction: "${soapAction}"`,
      '-d', body,
    ], { encoding: 'utf-8', timeout: 5000 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function parseXml(xml) {
  return new Promise((resolve, reject) => {
    parseString(xml, { explicitArray: false }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

// Get zone group topology from a speaker
async function getZoneGroups(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"></u:GetZoneGroupState></s:Body></s:Envelope>`;

  const response = await curlPost(
    ip,
    '/ZoneGroupTopology/Control',
    'urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState',
    body
  );

  if (!response) throw new Error(`Cannot reach speaker at ${ip}`);

  const parsed = await parseXml(response);
  const stateXml = parsed['s:Envelope']['s:Body']['u:GetZoneGroupStateResponse'].ZoneGroupState;
  const state = await parseXml(stateXml);

  let zoneGroups = state.ZoneGroupState.ZoneGroups.ZoneGroup;
  if (!Array.isArray(zoneGroups)) zoneGroups = [zoneGroups];

  return zoneGroups.map((zg) => {
    const coordinator = zg.$.Coordinator;
    let members = zg.ZoneGroupMember;
    if (!Array.isArray(members)) members = [members];

    const memberList = members
      .filter((m) => m.$.Invisible !== '1')
      .map((m) => {
        let host = null;
        try { host = new URL(m.$.Location).hostname; } catch {}
        return {
          name: m.$.ZoneName,
          uuid: m.$.UUID,
          host,
          isCoordinator: m.$.UUID === coordinator,
        };
      });

    const coord = memberList.find((m) => m.isCoordinator);
    return {
      id: zg.$.ID,
      name: coord ? coord.name : memberList[0]?.name || 'Unknown',
      coordinatorUuid: coordinator,
      coordinatorHost: coord?.host,
      members: memberList,
    };
  });
}

// Check transport state of a speaker (returns info about what's playing)
async function getTransportInfo(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetMediaInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetMediaInfo></s:Body></s:Envelope>`;

  const response = await curlPost(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#GetMediaInfo',
    body
  );

  if (!response) return null;
  const uriMatch = response.match(/<CurrentURI>(.*?)<\/CurrentURI>/);
  return {
    currentURI: uriMatch ? uriMatch[1] : '',
    isAirPlay: uriMatch ? (uriMatch[1].startsWith('x-sonos-vli:') || uriMatch[1].startsWith('x-sonosapi-vli:')) : false,
  };
}

// Join a speaker to a group coordinator
async function joinGroup(memberIp, coordinatorUuid) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>x-rincon:${coordinatorUuid}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>`;

  const response = await curlPost(
    memberIp,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
    body
  );

  if (!response) throw new Error(`Failed to join ${memberIp} to group`);
  return response;
}

// Remove a speaker from its group
async function leaveGroup(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:BecomeCoordinatorOfStandaloneGroup xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup></s:Body></s:Envelope>`;

  const response = await curlPost(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#BecomeCoordinatorOfStandaloneGroup',
    body
  );

  if (!response) throw new Error(`Failed to ungroup ${ip}`);
  return response;
}

// Send Play command to a speaker (needed after grouping with AirPlay)
async function play(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><Speed>1</Speed></u:Play></s:Body></s:Envelope>`;

  await curlPost(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#Play',
    body
  );
}

// Get volume for a speaker
async function getVolume(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume></s:Body></s:Envelope>`;

  const response = await curlPost(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1#GetVolume',
    body
  );

  if (!response) return null;
  const match = response.match(/<CurrentVolume>(\d+)<\/CurrentVolume>/);
  return match ? parseInt(match[1], 10) : null;
}

// Set volume for a speaker
async function setVolume(ip, volume) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${volume}</DesiredVolume></u:SetVolume></s:Body></s:Envelope>`;

  await curlPost(
    ip,
    '/MediaRenderer/RenderingControl/Control',
    'urn:schemas-upnp-org:service:RenderingControl:1#SetVolume',
    body
  );
}

// GET /api/speakers
app.get('/api/speakers', async (req, res) => {
  try {
    console.log(`Querying zone topology from ${SEED_SPEAKER}...`);
    const groups = await getZoneGroups(SEED_SPEAKER);

    // Fetch all volumes in parallel
    const allMembers = groups.flatMap((g) => g.members);
    const volumeResults = await Promise.all(
      allMembers.map((m) => m.host ? getVolume(m.host) : Promise.resolve(null))
    );
    const volumeMap = {};
    allMembers.forEach((m, i) => { volumeMap[m.host] = volumeResults[i]; });

    const speakers = groups.flatMap((g) =>
      g.members.map((m) => ({
        ...m,
        groupId: g.id,
        groupName: g.name,
        volume: volumeMap[m.host] ?? null,
      }))
    );

    console.log(`Found ${speakers.length} speaker(s) in ${groups.length} group(s)`);
    res.json({ speakers, groups });
  } catch (err) {
    console.error('Discovery error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group
app.post('/api/group', async (req, res) => {
  try {
    const { coordinatorHost, memberHosts } = req.body;
    if (!coordinatorHost || !memberHosts || memberHosts.length === 0) {
      return res.status(400).json({ error: 'coordinatorHost and memberHosts required' });
    }

    const groups = await getZoneGroups(SEED_SPEAKER);
    const allMembers = groups.flatMap((g) => g.members);

    // Check all speakers for AirPlay in parallel
    const infos = await Promise.all(memberHosts.map((h) => getTransportInfo(h)));
    let actualCoordinatorHost = coordinatorHost;
    for (let i = 0; i < memberHosts.length; i++) {
      if (infos[i] && infos[i].isAirPlay) {
        console.log(`AirPlay detected on ${memberHosts[i]} — promoting to coordinator`);
        actualCoordinatorHost = memberHosts[i];
        break;
      }
    }

    const coordinator = allMembers.find((m) => m.host === actualCoordinatorHost);
    if (!coordinator) {
      return res.status(404).json({ error: `Coordinator ${actualCoordinatorHost} not found` });
    }

    // Join all members in parallel
    await Promise.all(
      memberHosts
        .filter((h) => h !== actualCoordinatorHost)
        .map((h) => joinGroup(h, coordinator.uuid))
    );

    await play(actualCoordinatorHost);
    res.json({ success: true });
  } catch (err) {
    console.error('Grouping error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/group-house — group all house speakers, leave Patio alone
app.post('/api/group-house', async (req, res) => {
  try {
    const groups = await getZoneGroups(SEED_SPEAKER);
    const allMembers = groups.flatMap((g) => g.members);
    const houseMembers = allMembers.filter((m) => HOUSE_SPEAKERS.includes(m.name));

    if (houseMembers.length < 2) {
      return res.status(400).json({ error: 'Not enough house speakers found' });
    }

    // Check all house speakers for AirPlay in parallel
    const infos = await Promise.all(houseMembers.map((m) => getTransportInfo(m.host)));
    let coordinator = houseMembers[0];
    for (let i = 0; i < houseMembers.length; i++) {
      if (infos[i] && infos[i].isAirPlay) {
        console.log(`AirPlay detected on ${houseMembers[i].name} — promoting to coordinator`);
        coordinator = houseMembers[i];
        break;
      }
      if (infos[i] && infos[i].currentURI && !infos[i].currentURI.startsWith('x-rincon:')) {
        coordinator = houseMembers[i];
      }
    }

    // Join all non-coordinator members in parallel
    await Promise.all(
      houseMembers
        .filter((m) => m.host !== coordinator.host)
        .map((m) => joinGroup(m.host, coordinator.uuid))
    );

    await play(coordinator.host);
    res.json({ success: true, coordinator: coordinator.name });
  } catch (err) {
    console.error('Group house error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ungroup-house — ungroup all house speakers back to individual zones
app.post('/api/ungroup-house', async (req, res) => {
  try {
    const groups = await getZoneGroups(SEED_SPEAKER);

    const leavePromises = [];
    for (const g of groups) {
      const houseInGroup = g.members.filter((m) => HOUSE_SPEAKERS.includes(m.name));
      if (houseInGroup.length <= 1 || g.members.length <= 1) continue;

      for (const m of g.members) {
        if (!m.isCoordinator) {
          leavePromises.push(leaveGroup(m.host));
        }
      }
    }

    await Promise.all(leavePromises);
    res.json({ success: true });
  } catch (err) {
    console.error('Ungroup house error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/volume - set volume for a speaker
app.post('/api/volume', async (req, res) => {
  try {
    const { host, volume } = req.body;
    if (!host || volume === undefined) {
      return res.status(400).json({ error: 'host and volume required' });
    }
    await setVolume(host, Math.max(0, Math.min(100, parseInt(volume, 10))));
    res.json({ success: true });
  } catch (err) {
    console.error('Volume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ungroup
app.post('/api/ungroup', async (req, res) => {
  try {
    const { host } = req.body;
    if (!host) {
      return res.status(400).json({ error: 'host required' });
    }

    await leaveGroup(host);
    res.json({ success: true });
  } catch (err) {
    console.error('Ungrouping error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SonosControl running at http://localhost:${PORT}`);
  console.log(`Seed speaker: ${SEED_SPEAKER} (change with SONOS_IP env var)`);
});
