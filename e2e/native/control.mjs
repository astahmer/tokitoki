import fs from 'node:fs';
const path='/tmp/native-control.json';
const old=fs.existsSync(path)?JSON.parse(fs.readFileSync(path,'utf8')):{};
fs.writeFileSync(path,JSON.stringify({...JSON.parse(process.argv[2]||'{}'),revision:(old.revision||0)+1}));
