'use strict';
// Points an EXISTING Twilio number at the SecondShift handler, over the Twilio REST API.
// Never buys a number and never touches billing. Uses the Account SID + Auth Token from the
// secrets folder (twilio_account_sid.txt, twilio_auth_token.txt) — no console login.
//
//   node tools/twilio-wire.js list
//   node tools/twilio-wire.js wire <+1NUMBER> <https://public-host> [tenant]   (default tenant: carborundum)
//   node tools/twilio-wire.js unwire <+1NUMBER> <previous-voice-url>          (restore the old webhook)
const { loadSecrets } = require('../src/config');

async function api(sid, token, path, form) {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
    method: form ? 'POST' : 'GET',
    headers: { authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${j.message || JSON.stringify(j).slice(0, 200)}`);
  return j;
}

async function main() {
  const [cmd, number, arg, tenant = 'carborundum'] = process.argv.slice(2);
  const { twilioAccountSid: sid, twilioAuthToken: token, dir } = loadSecrets();
  if (!sid || !token) throw new Error(`Need twilio_account_sid.txt (AC…) and twilio_auth_token.txt in ${dir}`);
  const nums = (await api(sid, token, '/IncomingPhoneNumbers.json?PageSize=100')).incoming_phone_numbers;
  if (cmd === 'list' || !cmd) {
    for (const n of nums) console.log(`${n.phone_number}  ${n.friendly_name}  voice=${n.voice_url || '(none)'}  app=${n.voice_application_sid || '-'}  trunk=${n.trunk_sid || '-'}`);
    if (!nums.length) console.log('(no numbers on this account)');
    return;
  }
  const n = nums.find(x => x.phone_number === number);
  if (!n) throw new Error(`${number} is not on this account`);
  if (cmd === 'wire') {
    const url = `${arg.replace(/\/$/, '')}/voice/twilio?tenant=${encodeURIComponent(tenant)}`;
    console.log(`previous voice_url (save to undo): ${n.voice_url || '(none)'}`);
    const u = await api(sid, token, `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: url, VoiceMethod: 'POST', VoiceApplicationSid: '' });
    console.log(`${u.phone_number} -> ${u.voice_url}`);
  } else if (cmd === 'unwire') {
    const u = await api(sid, token, `/IncomingPhoneNumbers/${n.sid}.json`, { VoiceUrl: arg || '', VoiceMethod: 'POST' });
    console.log(`${u.phone_number} -> ${u.voice_url || '(none)'}`);
  } else throw new Error('commands: list | wire | unwire');
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
module.exports = { api };
