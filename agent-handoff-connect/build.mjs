import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
const result=await build({entryPoints:['src/cli.mjs'],outfile:'dist/cli.mjs',bundle:true,platform:'node',format:'esm',target:'node22',metafile:true,
  banner:{js:'#!/usr/bin/env node\nimport {createRequire as __createRequire} from "node:module"; const require=__createRequire(import.meta.url);'},
  legalComments:'eof',minify:false});
fs.chmodSync('dist/cli.mjs',0o755);
const packages=new Set();for(const file of Object.keys(result.metafile.inputs)){const match=file.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)/);if(match)packages.add(match[1]);}
const licenses=[];
for(const name of [...packages].sort()){
  const root=path.join('node_modules',name),meta=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  const license=fs.readdirSync(root).find(f=>/^(licen[sc]e|copying)(\.|$)/i.test(f));
  if(license)licenses.push(`${name} ${meta.version} (${meta.license||'see license'})\n\n${fs.readFileSync(path.join(root,license),'utf8')}`);
  else if(meta.license)licenses.push(`${name} ${meta.version}: ${meta.license}`);
  else throw new Error('Missing license for '+name);
}
fs.writeFileSync('dist/THIRD-PARTY-LICENSES.txt',licenses.join('\n\n'+'='.repeat(72)+'\n\n')+'\n');
