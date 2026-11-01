import locales from './radio-locales.json';
import aircraftNames from './radio-aircraft-names.json';
import type { RadioAction } from '../shared/radio';

type Kind = RadioAction['kind'];
type Role = 'center' | 'approach' | 'tower' | 'ground' | 'departure';
export interface RadioStation { name: string; role: Role }
export interface LocalizedHandoff extends RadioStation { frequency: number }
interface Locale {
  locale: string; menus: Record<string,string>; contact: Record<string,string>;
  tune: string; station: string; roles: Record<string,string>; grammar: Record<string,string[]>;
}
// Formatting is not meaning: normalize native punctuation, Unicode decimal digits,
// bidi formatting marks and spacing before matching. Never strip words or accents.
export function radioText(value: string): string {
  return value.normalize('NFKC').replace(/[\u0660-\u0669\u06f0-\u06f9\u0966-\u096f\u0e50-\u0e59]/g,
    c => String(c.charCodeAt(0) - (c >= '\u0e50' ? 0x0e50 : c >= '\u0966' ? 0x0966 : c >= '\u06f0' ? 0x06f0 : 0x0660)))
    .replace(/[。]/g,'.').replace(/[、،]/g,',').replace(/[’‘]/g,"'")
    .replace(/[\s\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,'').toLowerCase();
}
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const name = "[\\p{L}\\p{M}\\p{N}'_\\-]{1,80}?";
const stationName = "[\\p{L}\\p{M}\\p{N}.'’_\\-]{1,100}?";
const number = '[0-9]{1,6}(?:[.,][0-9]{1,3})?';
const frequency = '(?:11[89]|12[0-9]|13[0-6]|137)[.,][0-9]{1,3}(?![0-9])';
const alt = '(?:fl[0-9]{1,3}|[0-9]{1,6}(?:[,.][0-9]{3})?(?:ft|feet|foot|m|米|フィート|피트|футов|фута|фут|pieds|pie|pies|pés))';
const union = (parts: string[]) => `(?:${[...new Set(parts)].join('|')})`;
function template(value: string, slot: (key: string) => string): string {
  return radioText(value).split(/(\{[^{}]+\})/).map(part => part.startsWith('{') ? slot(part.slice(1,-1)) : escape(part)).join('');
}
const grammarCache = new Map<Locale, Map<string,string>>();
function grammar(l: Locale, key: string): string {
  let cache=grammarCache.get(l); if(!cache){cache=new Map();grammarCache.set(l,cache);}
  const prior=cache.get(key);if(prior!==undefined)return prior;
  // All placeholders are typed. Unrecognized dependencies fail closed; none is .*.
  const primitives: Record<string,string> = {
    callsign:name, station:stationName, speed:'[1-9][0-9]{0,2}', heading:'(?:[0-2]?[0-9]{1,2}|3[0-5][0-9]|360)',
    route:name, fix:name, identifier:'[a-z0-9]{1,8}', runwaynumber:'(?:0?[1-9]|[12][0-9]|3[0-6])',
    number, frequency, aircraft:name, leg:name, compass:name,
  };
  if(primitives[key])return primitives[key];
  if(key==='altitude')return union([alt, `${grammar(l,'flightlevel')}[0-9]{1,3}`, `[0-9]{1,6}(?:[,.][0-9]{3})?${grammar(l,'altitudeunit')}`]);
  let result: string;
  if(key==='centerhandoffmessage') {
    result=`${name},?${grammar(l,'handoff')}(?:${grammar(l,'human')})?`;
  } else if(key==='vector') {
    const part=union([grammar(l,'instruction'),grammar(l,'approachclearance'),grammar(l,'vectorsupplement')]);
    result=`(?:${part}(?:[,.;]?${part}){0,5})?`;
  } else {
    const sourceKey=Object.keys(l.grammar).find(k=>k.toLowerCase()===key);
    result=sourceKey ? union(l.grammar[sourceKey].map(v=>template(v,k=>grammar(l,k)))) : '(?!)';
    if (key === 'approachtype') result = union([result, '(?:ils|rnav|gps|vor(?:dme)?|ndb(?:dme)?|lda|sdf)']);
  }
  cache.set(key,result);return result;
}
const patterns = new Map<string,RegExp>();
function pattern(l: Locale, key: string, mode: 'full'|'fragment' = 'full'): RegExp {
  const id=`${l.locale}:${key}:${mode}`;let p=patterns.get(id);
  if(!p){p=new RegExp(mode==='full' ? `^${grammar(l,key.toLowerCase())}[.!?]?$` : grammar(l,key.toLowerCase()),'u');patterns.set(id,p);}
  return p;
}
const all = locales as Locale[];
export function localizedAcknowledgments(label: string): Kind[] {
  const value=radioText(label), result=new Set<Kind>();
  for(const l of all)for(const [kind,text] of Object.entries(l.menus))if(radioText(text)===value)result.add(kind as Kind);
  return [...result];
}
export function localizedReminder(text: string): boolean {
  const value=radioText(text);return all.some(l=>pattern(l,'reminder').test(value));
}
export function localizedLanding(text: string): boolean {
  const value=radioText(text);return all.some(l=>pattern(l,'landing','fragment').test(value));
}
const vectorEnvelopes = new Map<Locale,RegExp[]>();
function actionableVector(l: Locale, value: string): boolean {
  let envelopes=vectorEnvelopes.get(l);
  if(!envelopes){
    envelopes=l.grammar.instructionMessage.map(message=>new RegExp(`^${template(message,key=>key==='vector'?`(?<vector>${grammar(l,'vector')})`:grammar(l,key))}[.!?]?$`,'u'));
    vectorEnvelopes.set(l,envelopes);
  }
  return envelopes.some(p=>{
    const vector=p.exec(value)?.groups?.vector;
    return !!vector && pattern(l,'instruction','fragment').test(vector);
  });
}
export function localizedInstruction(kind: Kind, text: string): boolean {
  const value=radioText(text);
  return all.some(l=>{
    switch(kind){
      case 'acknowledge-instruction':
        // Supplementary information may accompany an instruction, but cannot
        // authorize a response alone. Inspect the vector, never the callsign.
        return actionableVector(l,value);
      case 'acknowledge-descent':return pattern(l,'descent').test(value);
      case 'acknowledge-arrival':return pattern(l,'arrival').test(value);
      case 'acknowledge-assigned-approach':return pattern(l,'assigned').test(value);
      case 'acknowledge-approach':return l.locale==='en-US' && pattern(l,'arrival').test(value) || (pattern(l,'instructionMessage').test(value) || pattern(l,'patternMessage').test(value)) && pattern(l,'approachClearance','fragment').test(value);
      case 'acknowledge-pattern-entry':return pattern(l,'patternMessage').test(value) || pattern(l,'instructionMessage').test(value) && pattern(l,'approachClearance','fragment').test(value);
      default:return false;
    }
  });
}
function capture(value: string, slots: Record<string,string>, full=true): RegExp {
  return new RegExp(`${full?'^':''}${template(value,key=>slots[key]??'(?!)')}${full?'$':''}`,'u');
}
const stationMatchers = all.flatMap(l=>Object.entries(l.roles).map(([role,text])=>({
  locale:l, specificity:radioText(text).length, role:role as Role, regex:capture(l.station,{name:`(?<name>(?:${stationName})?)`,role:escape(radioText(text))}),
})));
function station(value: string, locale?: Locale): RadioStation | null {
  // Station names may contain initials, but never a radio frequency. Otherwise
  // a second directive could be swallowed by the dynamic station-name slot.
  if (/[0-9][.,][0-9]/.test(value)) return null;
  let specificity = -1;
  const found = new Map<string,RadioStation>();
  for (const candidate of stationMatchers) {
    if (locale && candidate.locale !== locale) continue;
    const match=candidate.regex.exec(value);
    if (match?.groups) {
      if (candidate.specificity < specificity) continue;
      if (candidate.specificity > specificity) {found.clear();specificity=candidate.specificity;}
      const result={name:match.groups.name,role:candidate.role};
      found.set(JSON.stringify(result),result);
    }
  }
  // A translated role can mean both approach and departure. The menu is not
  // evidence of which controller issued the handoff, so ambiguity stays manual.
  return found.size === 1 ? [...found.values()][0] : null;
}
// Authorization uses complete message envelopes. The fragment grammar remains
// useful only for conservatively excluding operational text from weather.
const handoffMatchers = all.flatMap(l=>{
  const captured = (value: string) => template(value, key=> {
    if (key==='station') return `(?<station>${stationName})`;
    if (key==='frequency') return `(?<frequency>${frequency})`;
    if (key==='human') return `(?:${grammar(l,'human')})?`;
    return grammar(l,key);
  });
  const direct=l.grammar.handoffCall.map(body=>({
    locale:l, specificity:radioText(body.replace(/\{[^{}]+\}/g,'')).length,
    regex:new RegExp(`^(?<callsign>${name}),?${captured(body)}[.!?]?$`,'u'),
  }));
  const tower=l.grammar.towerHandoffMessage.flatMap(envelope=>l.grammar.towerContact.map(body=>({
    locale:l, specificity:radioText(body.replace(/\{[^{}]+\}/g,'')).length,
    regex:new RegExp(`^${template(envelope,key=>key==='towercontact'?captured(body):key==='callsign'?`(?<callsign>${name})`:grammar(l,key))}[.!?]?$`,'u'),
  })));
  return [...direct,...tower];
}).sort((a,b)=>b.specificity-a.specificity);
// Whitespace-free matching must not turn "Example 123 do not" into a callsign.
// Keep original token boundaries and case for the identifier. An abbreviated
// registration must have a known aircraft prefix; arbitrary prose stays manual.
const aircraftPrefixes = new Set(aircraftNames.map(radioText));
function identifiedCallsign(text: string, callsign: string, locale: Locale): boolean {
  const original=text.normalize('NFKC');
  let consumed=0, end=0;
  for(const character of original){
    consumed+=radioText(character).length;end+=character.length;
    if(consumed>=callsign.length)break;
  }
  const tokens=original.slice(0,end).trim().split(/\s+/);
  const suffix=radioText(tokens.at(-1)??'');
  if(['heavy',...locale.grammar.heavy.map(radioText)].includes(suffix))tokens.pop();
  const identifier=radioText(tokens.at(-1)??'');
  if(/[0-9]/.test(identifier) || /^[\p{L}]{1,3}-[\p{L}]{2,8}$/u.test(identifier))return true;
  const preserved=tokens.join(' '), abbreviated=preserved.match(/[A-Z]{2,5}$/)?.[0];
  return !!abbreviated && aircraftPrefixes.has(radioText(preserved.slice(0,-abbreviated.length)));
}
export function localizedHandoff(text: string): LocalizedHandoff | null {
  const value=radioText(text), found=new Map<string,LocalizedHandoff>();
  let specificity=-1;
  for(const candidate of handoffMatchers){
    if(candidate.specificity < specificity) break;
    const groups=candidate.regex.exec(value)?.groups;
    if(!groups || !identifiedCallsign(text,groups.callsign,candidate.locale))continue;
    const target=station(groups.station,candidate.locale), freq=Number(groups.frequency.replace(',','.'));
    if(!target || freq<118 || freq>137)continue;
    specificity=candidate.specificity;
    const result={...target,frequency:freq};found.set(JSON.stringify(result),result);
  }
  return found.size===1 ? [...found.values()][0] : null;
}
const contactMatchers=all.flatMap(l=>Object.entries(l.contact).map(([role,text])=>({
  role:role as Role, specificity:radioText(text.replace('{name}','')).length,
  regex:capture(text,{name:`(?<name>(?:${stationName})?)`}),
}))).sort((a,b)=>b.specificity-a.specificity);
const tuneMatchers=all.map(l=>capture(l.tune,{name:`(?<name>(?:${stationName})?)`,role:`(?<role>${union(Object.values(l.roles).map(s=>escape(radioText(s))))})`,mhz:'(?<mhz>[0-9]{3})',khz:l.tune.includes('{decimal}')?'(?<khz>[0-9]{1,3})':'(?<khz>[0-9]{3})',decimal:'[.,]'}));
export function localizedOption(text: string): {kind:'tune'|'contact'; station:RadioStation; frequency?:number} | null {
  const value=radioText(text);
  for(const c of contactMatchers){const g=c.regex.exec(value)?.groups;if(g)return {kind:'contact',station:{name:g.name,role:c.role}};}
  for(let i=0;i<tuneMatchers.length;i++){
    const g=tuneMatchers[i].exec(value)?.groups;if(!g)continue;
    const role=Object.keys(all[i].roles).find(k=>radioText(all[i].roles[k])===g.role) as Role;
    return {kind:'tune',station:{name:g.name,role},frequency:Number(`${g.mhz}.${g.khz}`)};
  }
  return null;
}
export function sameRadioStation(a: RadioStation,b: RadioStation): boolean { return a.role===b.role && a.name===b.name; }
// Check-in templates account for languages that place the station after the
// callsign. Replace only the station slot with the exact requested station.
const checkinCache=new Map<string,RegExp[]>();
export function localizedCheckin(text: string,target: RadioStation): boolean {
  const addressed = station(radioText(text).split(',')[0]);
  if (addressed && sameRadioStation(addressed, target)) return true;
  const key=JSON.stringify(target);let matchers=checkinCache.get(key);
  if(!matchers){
    matchers=all.flatMap(l=>l.grammar.checkin.map(value=>new RegExp(`^${template(value,k=>k==='station' ? template(l.station,s=>s==='name'?escape(target.name):escape(radioText(l.roles[target.role]))) : grammar(l,k))}[.!?]?$`,'u')));
    checkinCache.set(key,matchers);if(checkinCache.size>32)checkinCache.delete(checkinCache.keys().next().value!);
  }
  return matchers.some(p=>p.test(radioText(text)));
}

/** Mixed-language instructions must never be hidden inside a weather envelope. */
export function localizedOperationalCue(text: string): boolean {
  const value=radioText(text);
  return all.some(l=>['instruction','approachClearance','entry','descent','arrival','assigned','landing','handoff']
    .some(key=>pattern(l,key,'fragment').test(value)));
}

/** Recovery may tolerate a complete enroute handoff, never appended traffic. */
export function localizedEnrouteHandoff(text: string): boolean {
  return localizedHandoff(text)?.role === 'center' && all.some(l=>pattern(l,'centerHandoffMessage').test(radioText(text)));
}
