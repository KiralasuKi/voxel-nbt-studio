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
 if(!exe||!fs.existsSync(exe))return;
 const key=path.resolve(exe).toLowerCase();
 if(seen.has(key))return;
 seen.add(key);list.push(path.resolve(exe));
}
function pathJava(){
 const dirs=String(process.env.PATH||'').split(path.delimiter).filter(Boolean);
 for(const dir of dirs)if(fs.existsSync(path.join(dir,EXE)))return path.join(dir,EXE);
 return null;
}
function addHome(list,seen,home){
 if(!home)return;
 addFile(list,seen,path.join(home,'bin',EXE));
}
function scanHomes(list,seen,dir,depth){
 if(depth<0)return;
 let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
 for(const e of entries)if(e.isDirectory()){
  const full=path.join(dir,e.name);
  addHome(list,seen,full);
  scanHomes(list,seen,full,depth-1);
 }
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
const LABEL=process.platform==='win32'?'java.exe':'java';
// Resolves a Java launcher for the given libraries root. Source-file mode needs a
// JDK (jdk.compiler), so a launcher with a sibling javac wins over a plain JRE.
async function javaExe(librariesRoot,needed){
 const want=Number(needed)||25,key=String(librariesRoot||'')+'|'+want;
 if(cache.has(key))return cache.get(key);
 const list=[],seen=new Set();
 addFile(list,seen,process.env.VOXEL_JAVA);
 const install=librariesRoot?path.dirname(librariesRoot):null;
 if(install){
  const homesPath=path.join(install,'java');
  let homes=[];try{homes=fs.readdirSync(homesPath,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(homesPath,d.name));}catch{}
  homes.sort();
  for(const home of homes)addHome(list,seen,home);
  scanHomes(list,seen,path.join(install,'runtime'),4);
 }
 addFile(list,seen,pathJava());
 const found=[];
 for(const exe of list){
  const major=await majorFor(exe);
  if(major&&major<want)continue;
  found.push({exe,major,jdk:hasCompiler(exe)});
 }
 const pick=found.find(x=>x.jdk)||found[0];
 const value=pick?pick.exe:(list[0]||LABEL);
 cache.set(key,value);
 return value;
}
async function javaHint(librariesRoot,needed){
 const exe=await javaExe(librariesRoot,needed);
 return hasCompiler(exe)?exe:`${exe}（不是 JDK，缺少 ${COMPILER}）`;
}
module.exports={javaExe,javaHint};
