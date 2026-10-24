import http from 'node:http';
import fs from 'node:fs';
http.createServer((req,res)=>{
 if (req.url==='/e2e/control') {res.end(fs.existsSync('/tmp/native-control.json')?fs.readFileSync('/tmp/native-control.json'):'{"revision":0}');return;}
 if (req.url==='/e2e/state') {let body='';req.on('data',c=>body+=c);req.on('end',()=>{fs.appendFileSync('/out/plasma-states.jsonl',body+'\n');res.end('ok');});return;}
 const p=JSON.parse(fs.readFileSync('/tmp/native-payload.json','utf8'));
 if (p.failure) {res.writeHead(503);res.end('fixture unavailable');return;}
 const canonical = {version:1,generatedAt:p.generatedAt,accounts:p.limits.map(a=>({...a,id:a.provider+'@'+a.accountKey,vendorName:({openai:'OpenAI',anthropic:'Anthropic',cursor:'Cursor'})[a.vendor]||a.vendor,windows:a.windows.map(w=>({...w,source:w.source==='embedded'?'provider':w.source,usedPercent:w.usedPct,costUsd:w.cost})),budgetWindows:(a.budgetWindows||[]).map(w=>({...w,costUsd:w.cost}))}))};
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify(req.url==='/v1/limits'?canonical:{...p,t3codeActivity:p.t3codeActivity[0].total}));
}).listen(6736,'127.0.0.1');
