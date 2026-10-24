import fs from 'node:fs';
const now = Date.now();
const iso = (minutes) => new Date(now + minutes * 60000).toISOString();
const quota = (id, minutes, used, extra = {}) => ({id, kind: id, label: id, source: 'embedded', status: 'current', windowMinutes: minutes, usedPct: used, observedAt: iso(-2), resetsAt: iso(minutes / 2), tokens: 0, requests: 0, cost: 0, ...extra});
const account = (provider, vendor, accountKey, label, windows, budgetWindows = []) => ({provider, vendor, accountKey, label, windows, budgetWindows});
const payload = {schema:1, app:'tokitoki', generatedAt: iso(0), window:{label:'Today'}, stats:{costUsd:21.92,tokens:154686297,requests:745,sessions:6,cachePct:49}, uiPreview:{previewHidden:[],menubarHidden:[],privacyHideIdentities:false}, limits:[
 account('codex','openai','evvi','Evvi',[quota('session',300,20), quota('weekly',10080,37)], [quota('day',1440,25,{source:'derived',cost:8.2,tokens:54000})]),
 account('codex','openai','work','Work',[quota('session',300,45),quota('weekly',10080,70)]),
 account('cursor','cursor','personal','Personal',[quota('monthly',43200,63,{label:'Cursor Models'}),quota('other',43200,8,{label:'Other Models'}),quota('on-demand',43200,100,{label:'On-Demand',amountUsd:2.5})]),
 account('claude-code','anthropic','archived','Archived',[quota('session',300,0,{status:'expired',resetsAt:iso(-1)}),quota('weekly',10080,10,{status:'stale'})]),
], t3codeActivity:[{key:'today',total:{requests:5,sessions:3,costUsd:.42}}]};
fs.writeFileSync('/tmp/native-payload.json',JSON.stringify(payload));
