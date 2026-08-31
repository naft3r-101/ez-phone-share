// Advertise a stable hostname over mDNS so a bookmark or home-screen icon on
// the phone survives DHCP handing this PC a different IP.
//
// Two Windows details matter here, both verified by hand against `ping`:
//   - The responder must be pinned to the real LAN interface. Left unpinned it
//     answers with whichever adapter replies first, which on a dev box is a
//     WSL/Hyper-V virtual adapter the phone cannot route to. Same class of
//     problem scoreCandidate() already solves for the HTTP URL.
//   - IPv6 must be disabled. With AAAA records published the name resolves to
//     a link-local fe80:: address that the phone cannot reach.
//
// This never throws into the caller: losing mDNS costs the pretty hostname,
// not the app, and the IP URL keeps working regardless.
const { Bonjour } = require('bonjour-service');

const HOSTNAME = 'ezshare.local';

let bonjour = null;
let published = false;

function start({ ip, port }) {
  stop();
  if (!ip || ip === 'localhost') return false;
  try {
    bonjour = new Bonjour({ interface: ip });
    const svc = bonjour.publish({
      name: 'Ez Phone Share',
      type: 'http',
      port,
      host: HOSTNAME,
      disableIPv6: true,
      txt: { app: 'ez-phone-share' },
    });
    svc.on('up', () => { published = true; });
    svc.on('error', (e) => { published = false; console.warn('mDNS publish error:', e.message); });
    return true;
  } catch (e) {
    console.warn('mDNS unavailable:', e.message);
    bonjour = null;
    return false;
  }
}

function stop() {
  published = false;
  if (!bonjour) return;
  try { bonjour.unpublishAll(); bonjour.destroy(); } catch { /* noop */ }
  bonjour = null;
}

function getHostname() { return HOSTNAME; }
function isPublished() { return published; }

module.exports = { start, stop, getHostname, isPublished };
