'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const run=promisify(execFile);
const EXE=process.platform==='win32'?'java.exe':'java';
const COMPILER=process.platform==='win32'?'javac.exe':'javac';
const cache=new Map();

function majorOf(text){
 const m=/version "(\d+)(?:\.(\d+))?/.exec(text);
 if(!m)return 0;
 const first=Number(m[1]);
 return first===1?Number(m[2]):first;
}
function releaseMajor(home){
 try{const m=/JAVA_VERSION="(\d+)/.exec(fs.readFileSync(path.join(home,'release'),'utf8'));return m?Number(m[1]):0;}catch{return 0;}
}
function hasCompiler(exe){
 return fs.existsSync(path.join(path.dirname(exe),COMPILER));
}
function addFile(list,seen,exe){
 if(!exe||!path.isAbsolute(exe))return;
 let resolved;try{resolved=fs.realpathSync(exe);if(!fs.statSync(resolved).isFile())return;}catch{return;}
 const key=process.platform==='win32'?resolved.toLowerCase():resolved;
 if(seen.has(key))return;
 seen.add(key);list.push(resolved);
}
function addHome(list,seen,home){
 if(!home)return;
 addFile(list,seen,path.join(home,'bin',EXE));
}
async function majorFor(exe){
 const home=path.dirname(path.dirname(exe));
 const known=releaseMajor(home);
 if(known)return known;
 try{
  const r=await run(exe,['-version'],{windowsHide:true,timeout:15000});
  return majorOf(String(r.stderr)+String(r.stdout));
 }catch{return 0;}
}
// Source-file mode needs a JDK. Never execute a Java from an opened workspace.
async function javaExe(needed){
 const want=Number(needed)||25,key=[want,process.env.VOXEL_JAVA,process.env.JAVA_HOME,process.env.PATH].join('|');
 if(cache.has(key))return cache.get(key);
 const list=[],seen=new Set();
 addFile(list,seen,process.env.VOXEL_JAVA);
 addHome(list,seen,process.env.JAVA_HOME);
 for(const dir of (process.env.PATH||'').split(path.delimiter).filter(Boolean))addFile(list,seen,path.join(dir,EXE));

 for(const exe of list){
  if(hasCompiler(exe)&&await majorFor(exe)>=want){cache.set(key,exe);return exe;}
 }
 throw new Error(`需要 Java ${want} 或更高版本的 JDK（带 javac）。请设置 JAVA_HOME 或 VOXEL_JAVA。`);
}
module.exports={javaExe};
