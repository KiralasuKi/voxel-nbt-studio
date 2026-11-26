'use strict';
const fs=require('node:fs/promises');
const {constants:{COPYFILE_EXCL}}=require('node:fs');
const path=require('node:path');
const {Worker}=require('node:worker_threads');
const {createHash,randomUUID}=require('node:crypto');
const {MAX_BYTES}=require('./nbt-codec');
const {gameClasspath}=require('./native-summon');

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function atomicFile(file,data,expected,exclusive=false){
  const tmp=path.join(path.dirname(file),`.voxel-${randomUUID()}.tmp`);
  try{
    const mode=await fs.stat(file).then(s=>s.mode).catch(e=>{if(e.code!=='ENOENT')throw e;});
    await fs.writeFile(tmp,data,{flag:'wx',mode});
    if(expected&&(await fs.stat(file)).size>MAX_BYTES)throw new Error('磁盘文件已被替换。请重新打开文件，或另存为。');
    if(expected&&hash(await fs.readFile(file))!==expected)throw new Error('磁盘文件已被外部修改。请重新打开文件，或另存为，避免覆盖。');
    if(exclusive)await fs.link(tmp,file).catch(e=>{
      if(!['ENOSYS','ENOTSUP','EOPNOTSUPP','EPERM','EXDEV'].includes(e.code))throw e;
      return fs.copyFile(tmp,file,COPYFILE_EXCL);
    });
    else await fs.rename(tmp,file);
  }finally{await fs.unlink(tmp).catch(()=>{});}
}
// Each open document owns a worker and a queue shared by all its editor panels.
class Document {
  constructor(uri, file, backup) {
    this.uri = uri;
    this.file = file;
    this.recovered = Boolean(backup);
    this.panels = new Set();
    this.inflight = new Map();
    this.seq = 0;
    this.queue = Promise.resolve();

    this.worker = new Worker(path.join(__dirname, 'worker.js'));
    this.worker.on('message', ({id, result, error}) => {
      const call = this.inflight.get(id);
      if (!call) return;
      this.inflight.delete(id);
      if (error) call.reject(new Error(error));
      else call.resolve(result);
    });
    this.worker.on('error', error => this.stop(error));
    this.worker.on('exit', () => this.stop(new Error('NBT 工作线程已退出，请重新打开文件。')));
    this.ready = this.call('load', file, backup).then(disk => { this.disk = disk; });
    // The first webview message will report load errors when it awaits ready.
    this.ready.catch(() => {});
  }

  call(method, ...args) {
    if (this.dead) return Promise.reject(this.dead);
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.inflight.set(id, {resolve, reject});
      try {
        this.worker.postMessage({id, method, args});
      } catch (error) {
        this.inflight.delete(id);
        reject(error);
      }
    });
  }

  run(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }

  stop(error) {
    this.dead = error;
    for (const call of this.inflight.values()) call.reject(error);
    this.inflight.clear();
  }

  dispose() {
    this.stop(new Error('文件已关闭'));
    this.worker.terminate();
    this.panels.clear();
  }

  async upgrade(jar,version,destination,canWrite) {
    const game=await gameClasspath(jar);
    const {data,hash:h}=await this.call('prepareUpgrade',game,version);
    let replace=false;
    try{
      if(!canWrite())return false;
      if(destination)await atomicFile(destination,data,null,true);
      else{await atomicFile(this.file,data,this.disk);this.disk=h;this.maskPack=null;replace=true;}
      return true;
    }finally{await this.call('finishUpgrade',replace);}
  }

  async view(pane, growth) {
    const data = await this.call('view', pane.palette);
    pane.palette = data.palette;
    pane.panel.webview.postMessage({type: 'model', data, growth});
  }

  async refreshEntities() {
    this.broadcast({type: 'entityRows', data: await this.call('entityRows')});
  }

  broadcast(message) {
    for (const pane of this.panels) {
      if (pane.active) pane.panel.webview.postMessage(message);
    }
  }
}

module.exports = {Document, atomicFile};
