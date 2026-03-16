const express = require('express');
const { execSync } = require('child_process');
const { parseString } = require('xml2js');
const path = require('path');

const os = require('os');

const app = express();
const PORT = 3000;
const SEED_SPEAKER = process.env.SONOS_IP || '192.168.1.64';
const CURL = os.platform() === 'darwin' ? '/usr/bin/curl' : 'curl';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Use system curl since Node.js http can't reach Sonos on this network
function sonosFetch(ip, urlPath) {
  try {
    return execSync(
      `${CURL} -s --connect-timeout 3 "http://${ip}:1400${urlPath}"`,
      { encoding: 'utf-8', timeout: 5000 }
    );
  } catch {
    return null;
  }
}

function sonosPost(ip, urlPath, soapAction, body) {
  try {
    return execSync(
      `${CURL} -s --connect-timeout 3 -X POST "http://${ip}:1400${urlPath}" ` +
      `-H 'Content-Type: text/xml; charset="utf-8"' ` +
      `-H 'SOAPAction: "${soapAction}"' ` +
      `-d '${body}'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
  } catch {
    return null;
  }
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

  const response = sonosPost(
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

    const memberList = members.map((m) => {
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

// Join a speaker to a group coordinator
function joinGroup(memberIp, coordinatorUuid) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID><CurrentURI>x-rincon:${coordinatorUuid}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData></u:SetAVTransportURI></s:Body></s:Envelope>`;

  const response = sonosPost(
    memberIp,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
    body
  );

  if (!response) throw new Error(`Failed to join ${memberIp} to group`);
  return response;
}

// Remove a speaker from its group
function leaveGroup(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:BecomeCoordinatorOfStandaloneGroup xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:BecomeCoordinatorOfStandaloneGroup></s:Body></s:Envelope>`;

  const response = sonosPost(
    ip,
    '/MediaRenderer/AVTransport/Control',
    'urn:schemas-upnp-org:service:AVTransport:1#BecomeCoordinatorOfStandaloneGroup',
    body
  );

  if (!response) throw new Error(`Failed to ungroup ${ip}`);
  return response;
}

// Get volume for a speaker
function getVolume(ip) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel></u:GetVolume></s:Body></s:Envelope>`;

  const response = sonosPost(
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
function setVolume(ip, volume) {
  const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1"><InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>${volume}</DesiredVolume></u:SetVolume></s:Body></s:Envelope>`;

  sonosPost(
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

    const speakers = groups.flatMap((g) =>
      g.members.map((m) => ({
        ...m,
        groupId: g.id,
        groupName: g.name,
        volume: m.host ? getVolume(m.host) : null,
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

    // Find the coordinator's UUID
    const groups = await getZoneGroups(SEED_SPEAKER);
    const allMembers = groups.flatMap((g) => g.members);
    const coordinator = allMembers.find((m) => m.host === coordinatorHost);
    if (!coordinator) {
      return res.status(404).json({ error: `Coordinator ${coordinatorHost} not found` });
    }

    for (const memberHost of memberHosts) {
      if (memberHost !== coordinatorHost) {
        joinGroup(memberHost, coordinator.uuid);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Grouping error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/volume - set volume for a speaker
app.post('/api/volume', (req, res) => {
  try {
    const { host, volume } = req.body;
    if (!host || volume === undefined) {
      return res.status(400).json({ error: 'host and volume required' });
    }
    setVolume(host, Math.max(0, Math.min(100, parseInt(volume, 10))));
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

    leaveGroup(host);
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
