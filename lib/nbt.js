'use strict';
const zlib = require('node:zlib');
const {createHash}=require('node:crypto');
const SNBT_TEXT=4*1024*1024,SNBT_NODES=250000;
const {parse}=require('./snbt');
const {
  Reader, utf, int, flag, named, listHeader, posBytes, fail, MAX_BYTES,
  numbers, nbtMatches, updated, editCompound, compoundFieldAt,
}=require('./nbt-codec');
const {
  entityId, entityView, stripEntityIdentity, packEntity, entityTransform, playerHeads, nbtProfile,
}=require('./entity-data');
const tileTypes=require('../media/block-entities.json');
const stateSchema=require('../media/state-schema.json');
const {rotate,rotateState,orientationTurns}=require('./rotation');
const mixedLists=dv=>dv==null||dv>=4325; // Java Edition 1.21.5
const { promisify } = require('node:util');
const codecs = { gzip: promisify(zlib.gzip), zlib: promisify(zlib.deflate) };
const MAX_VOLUME = 16 * 1024 * 1024;
const MAX_STATES = 32767;
const MAX_EDIT = 262144;
const MAX_CLIP = 32768, MAX_CLIP_BYTES = 16*1024*1024;
const FLUID = new Set(['minecraft:water','minecraft:lava','minecraft:bubble_column']);
const STRUCTURE_VOID = 'minecraft:structure_void';
const AIR_STATE={name:'minecraft:air',props:{}};
const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', STRUCTURE_VOID]);
function stateKey(v){return v.name+'\0'+JSON.stringify(Object.entries(v.props||{}).sort(([a],[b])=>a.localeCompare(b)));}
function validateState(st){
  if(!st||typeof st.name!=='string'||st.name.length>160||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(st.name))fail('方块 ID 无效，请用 minecraft:stone 这样的格式');
  const e=Object.entries(st.props||{});if(e.length>32||e.some(([k,v])=>!(/^[a-z0-9_]+$/.test(k))||typeof v!=='string'||v.length>120||!(/^[a-zA-Z0-9_.:/+-]+$/.test(v))))fail('方块属性无效，示例：axis=y');
  return {name:st.name,props:Object.fromEntries(e)};
}
function paletteBytes(state,modern){
  const e=Object.entries(state.props);return Buffer.concat([named(8,modern?'id':'Name',utf(state.name)),...(e.length?[named(10,modern?'properties':'Properties',Buffer.concat([...e.map(([k,v])=>named(8,k,utf(v))),flag(0)]))]:[]),flag(0)]);
}
function freshTile(type){return Buffer.concat([named(8,'id',utf(type)),flag(0)]);}
function commandCompound(text,dv){
  const value=parse(text,utf,mixedLists(dv));if(value.type!==10)fail('方块实体 SNBT 必须是 compound');return value.data;
}
function clipThumb(clip){
  const {size,blocks}=clip,[w,h,d]=size,visible=[],invisible=[],states=[],slots=new Map();
  for(const b of blocks)(AIR.has(clip.states[b.id].name)?invisible:visible).push(b);
  const sample=(list,limit)=>{
    const stride=Math.max(1,Math.ceil(list.length/limit));
    return list.filter((_,i)=>i%stride===0).map(({pos,id})=>{
      if(!slots.has(id)){slots.set(id,states.length);states.push(clip.states[id]);}
      return [...pos,slots.get(id)];
    });
  };
  const thumb=sample(visible,1536),invisibleThumb=sample(invisible,512),occupied=new Set(blocks.map(({pos:[x,y,z]})=>x+w*(z+d*y)));
  const volume=w*h*d,step=Math.max(1,Math.ceil(volume/512));
  for(let i=0;i<volume;i+=step)if(!occupied.has(i))invisibleThumb.push([i%w,Math.floor(i/(w*d)),Math.floor(i/w)%d,-1]);
  return {size,count:blocks.length,thumb,invisibleThumb,states};
}
function clipEntityPreview(clip){
  return (clip.entities??[]).flatMap((raw,index)=>{
    const row=entityView(Buffer.from(raw));if(!row)return [];const {pos,id,rotation,rotationMode,baby,invisible,variant,profile,hanging}=row;return [{index,pos,id,rotation,rotationMode,baby,invisible,variant,profile,hanging}];
  });
}
function clipHeadProfiles(clip){
  const [w,,d]=clip.size;
  return clip.blocks.flatMap(({pos:[x,y,z],id,tile})=>{
    if(!tile||!playerHeads.has(clip.states[id]?.name))return [];
    const bytes=Buffer.from(tile),profile=nbtProfile(bytes,new Reader(bytes).fields());return profile?[[x+w*(z+d*y),profile]]:[];
  });
}
function clipBytes(clip){
  const {size,blocks,states,dv,modern}=clip;
  return Buffer.concat([flag(10),utf(''),...(dv==null?[]:[named(3,'DataVersion',int(dv))]),named(9,'size',posBytes(size)),
    flag(9),utf('palette'),listHeader(10,states.length),...states.map(s=>paletteBytes(s,modern)),
    flag(9),utf('blocks'),listHeader(10,blocks.length),...blocks.map(b=>simpleBlock(b.pos,b.id,b.tile?relocateTile(Buffer.from(b.tile),b.pos):null)),
    named(9,'entities',Buffer.concat([listHeader(10,clip.entities?.length??0),...(clip.entities??[]).map(b=>Buffer.from(b))])),flag(0)]);
}
function relocateTile(bytes,pos){const f=new Reader(bytes).fields(),updates=[];
  for(const [i,k] of ['x','y','z'].entries())if(f.get(k)?.type===3)updates.push({...f.get(k),payload:[int(pos[i])]});
  return updated(bytes,updates);
}
function simpleBlock(xyz,state,tile){return Buffer.concat([named(9,'pos',posBytes(xyz)),named(3,'state',int(state)),...(tile?[named(10,'nbt',tile)]:[]),flag(0)]);}
function tilePath(path){if(typeof path!=='string'||path.length>256||!/^[-_A-Za-z0-9]+(?:\.[-_A-Za-z0-9]+){0,7}$/.test(path))fail('字段路径无效，例如 config.loot_table');return path.split('.');}
const tileIdentity=['id','x','y','z'];
function editNbtFields(bytes,fields,dv,protectedKeys,preserveType=false){
  if(!Array.isArray(fields)||!fields.length||fields.length>128)fail('NBT 字段数量无效');
  const seen=new Set();let length=0,data=bytes;
  for(const f of fields){
    const key=f?.key;
    if(typeof key!=='string'||protectedKeys.includes(key)||seen.has(key))fail('NBT 字段名无效；ID 和位置由编辑器管理，请在位置栏修改实体位置');
    seen.add(key);length+=key.length+(typeof f.text==='string'?f.text.length:0);
    if(length>256*1024)fail('本次 NBT 编辑超过 256 KiB');
    const value=f.remove===true?null:parse(f.text,utf,mixedLists(dv));
    const old=preserveType&&value?compoundFieldAt(bytes,[key]):null;
    if(old&&value.type!==old.type)fail('标签类型改变。若确实要改类型，请在高级 SNBT 中勾选“允许更改标签类型”。');
    data=editCompound(data,[key],value);
  }
  return data;
}
function create(size,dv=5023){
  dimensions(size);
  if(!Number.isInteger(dv)||dv<1||dv>2147483647)fail('结构 DataVersion 无效');
  return Buffer.concat([flag(10),utf(''),named(3,'DataVersion',int(dv)),named(9,'size',posBytes(size)),named(9,'palette',listHeader(10,0)),named(9,'blocks',listHeader(10,0)),named(9,'entities',listHeader(10,0)),flag(0)]);
}
function dimensions(size){if(!Array.isArray(size)||size.length!==3||!size.every(n=>Number.isInteger(n)&&n>0&&n<=4096)||size[0]*size[1]*size[2]>MAX_VOLUME)fail('结构尺寸超限（单轴 4096，体积约 1600 万格）');return size[0]*size[1]*size[2];}
function shape(buf,entry,type,name){if(!entry||entry.type!==type)fail(`不是 Java 结构 NBT，缺少或无法读取 ${name}`);return new Reader(buf,entry.at);}
function palette(r){
  const kind=r.byte(),count=r.len(),at=r.p;
  if((kind!==10&&!(count===0&&kind===0))||count>MAX_STATES)fail('方块调色板不受支持');
  let modern=null;const states=[];
  for(let i=0;i<count;i++){
    const fields=r.fields(),isModern=fields.has('id');
    const n=shape(r.b,fields.get(isModern?'id':'Name'),8,'方块 ID').str();
    const prop=fields.get(isModern?'properties':'Properties'), props={};
    if(prop)for(const [k,v] of shape(r.b,prop,10,'方块属性').fields())Object.defineProperty(props,k,{value:shape(r.b,v,8,'方块属性值').str(),enumerable:true});
    states.push({name:n,props});modern??=isModern;
  }
  return {states,count,at,end:r.p,modern};
}
class Structure {
  static async open(input){
    const b=Buffer.from(input); if(b.length>MAX_BYTES)fail('压缩文件超过 256 MiB');
    const zip=b[0]===31&&b[1]===139?'gzip':b[0]===0x78&&((b[0]<<8)+b[1])%31===0?'zlib':'raw';
    const raw=zip==='raw'?b:await promisify(zip==='gzip'?zlib.gunzip:zlib.inflate)(b,{maxOutputLength:MAX_BYTES});
    return new Structure(b,raw,zip);
  }
  constructor(original,b,zip){
    this.original=original;this.b=b;this.zip=zip;this.delta=new Map();this.extra=[];this.extraVariants=new Map();this.tiles=new Map();this.entityEdits=new Map();
    const r=new Reader(b);if(r.byte()!==10)fail('仅支持 Java 大端结构 NBT；文件不是受支持的结构模板');
    r.skipStr();const f=r.fields();this.fields=f;if(r.p!==b.length)fail('NBT 根节点之后存在多余数据，未打开为可编辑文件');
    this.size=shape(b,f.get('size'),9,'size').ints3();this.volume=dimensions(this.size);
    this.dv=f.get('DataVersion')?.type===3?new Reader(b,f.get('DataVersion').at).int():null;
    this.palField=f.get('palettes')||f.get('palette');this.multi=f.has('palettes');
    const pr=shape(b,this.palField,9,'palette / palettes');
    if(this.multi){const t=pr.byte(),n=pr.len();if(t!==9||n<1||n>64)fail('多调色板格式不受支持');this.palettes=Array.from({length:n},()=>palette(pr));}
    else this.palettes=[palette(pr)];
    this.paletteCount=this.palettes[0].count;if(this.palettes.some(p=>p.count!==this.paletteCount))fail('多套调色板的尺寸不一致');
    this.keys=new Map(this.palettes[0].states.map((s,i)=>[stateKey(s),i]));
    this.blocksField=f.get('blocks');const br=shape(b,this.blocksField,9,'blocks');
    const kind=br.byte(),n=br.len();if((kind!==10&&!(n===0&&kind===0))||n>this.volume)fail('方块列表尺寸或类型无效');
    this.blockStart=new Uint32Array(n+1);this.blockCell=new Uint32Array(n);this.blockValue=new Uint32Array(n);this.index=new Uint32Array(this.volume);
    for(let i=0;i<n;i++){
      this.blockStart[i]=br.p;let t,xyz=null,state=-1,tile=false;
      while((t=br.byte())!==0){
        const k=br.blockKey();
        if(k===1&&t===9)xyz=br.ints3();else if(k===2&&t===3)state=br.int();else{if(k===3&&t===10)tile=true;br.skipTag(t);}
      }
      if(!xyz||state<0||state>=this.paletteCount)fail('模板中有无效的方块坐标或调色板索引');
      const cell=this.cell(xyz);if(this.index[cell])fail('模板中存在重复的方块坐标');
      this.index[cell]=i+1;this.blockCell[i]=cell;this.blockValue[i]=(state+1)*2+Number(tile);
    }
    this.blockStart[n]=br.p;
    this.entities=0;if(f.get('entities')?.type===9){const er=new Reader(b,f.get('entities').at);er.byte();this.entities=er.len();}
    this.rootFields=[...f.keys()];
  }
  cell(p){const [x,y,z]=p,[w,h,d]=this.size;if(!Number.isInteger(x)||!Number.isInteger(y)||!Number.isInteger(z)||x<0||y<0||z<0||x>=w||y>=h||z>=d)fail('方块坐标超出结构边界');return x+w*(z+d*y);}
  pos(i){const [x,,z]=this.size;const q=Math.floor(i/x);return [i%x,Math.floor(q/z),q%z];}
  originalAt(i){const k=this.index[i];return k?this.blockValue[k-1]:0;}
  at(i){return this.delta.get(i)??this.originalAt(i);}
  set(i,v){if(this.originalAt(i)===v)this.delta.delete(i);else this.delta.set(i,v);}
  state(id,p=0){return this.palettes[p].states[id]??this.extraVariants.get(id)?.[p]??this.extra[id-this.paletteCount];}
  paletteView(p=0){const pal=this.palettes[p];if(!pal)fail('找不到该调色板');return [...pal.states,...this.extra.map((s,i)=>this.extraVariants.get(this.paletteCount+i)?.[p]??s)];}
  headProfile(i,p){
    if(!(this.at(i)&1)||!playerHeads.has(this.state((this.at(i)>>1)-1,p)?.name))return;
    const tile=this.tileAt(i);return tile&&nbtProfile(tile,new Reader(tile).fields());
  }
  snapshot(p=0){
    if(!Number.isInteger(p))p=0;p=Math.max(0,Math.min(p,this.palettes.length-1));
    const states=this.paletteView(p),visible=states.map(s=>!AIR.has(s.name)),headProfiles=[];
    const total=this.blockCell.length+this.delta.size;
    // Pack ordinary and invisible records separately so the visible mesh never loses explicit air data.
    const data=Buffer.allocUnsafe(total*8);let n=0,m=data.length;
    const write=(i,v)=>{
      if(!v)return;
      if(v&1){const profile=this.headProfile(i,p);if(profile)headProfiles.push([i,profile]);}
      const show=visible[(v>>1)-1],at=show?n:(m-=8);
      data.writeUInt32LE(i,at);data.writeUInt32LE(v,at+4);if(show)n+=8;
    };
    for(let j=0;j<this.blockCell.length;j++){const i=this.blockCell[j];write(i,this.at(i));}
    for(const [i,v] of this.delta)if(!this.index[i])write(i,v);
    return {size:this.size,states,count:this.palettes.length,palette:p,visible:n/8,records:this.blockCell.length,headProfiles,entities:this.entities,entityList:this.entityList(),dv:this.dv,zip:this.zip,rootFields:this.rootFields,maskCells:m<data.length?data.toString('base64',m):undefined,voxels:data.toString('base64',0,n)};
  }
  copySelection(selection,palette,includeInvisible=false,region=null,withEntities=false){
    if(!Array.isArray(selection)||selection.length>MAX_CLIP||!this.palettes[palette])fail('请选择不超过 32768 条方块记录再复制');
    const picked=new Set(selection),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],blocks=[],states=[],ids=new Map();let bytes=0;
    if(region){
      const {lo:a,hi:b}=region;
      if(!Array.isArray(a)||!Array.isArray(b)||a.length!==3||b.length!==3||a.some((v,i)=>v>b[i]))fail('无效的模板范围');
      this.cell(a);this.cell(b);
      if(a.reduce((n,v,i)=>n*(b[i]-v+1),1)>MAX_EDIT)fail('选区过大，请缩小模板范围');
      for(let i=0;i<3;i++){lo[i]=a[i];hi[i]=b[i];}
      // Records of explicit air belong to the box even when they are hidden during editing.
      for(let y=a[1];y<=b[1];y++)for(let z=a[2];z<=b[2];z++)for(let x=a[0];x<=b[0];x++){
        const c=this.cell([x,y,z]);if(AIR.has(this.state((this.at(c)>>1)-1,palette)?.name))picked.add(c);
        if(picked.size>MAX_CLIP)fail('临时模板的方块记录超过 32768 格，请缩小范围');
      }
    }
    for(const c of picked){
      if(!Number.isInteger(c)||c<0||c>=this.volume)fail('复制坐标无效');
      const value=this.at(c),id=(value>>1)-1,state=this.state(id,palette);if(!region&&includeInvisible!==true&&(!state||AIR.has(state.name)))continue;
      const pos=this.pos(c);
      for(let a=0;a<3;a++){lo[a]=Math.min(lo[a],pos[a]);hi[a]=Math.max(hi[a],pos[a]);}
      if(!state)continue;
      const tile=(value&1)?this.tileAt(c):null;
      if(!ids.has(id)){ids.set(id,states.length);states.push(state);bytes+=JSON.stringify(state).length*3;}
      bytes+=32+(tile?.length||0);if(bytes>MAX_CLIP_BYTES)fail('临时模板超过 16 MiB，请缩小选区');
      blocks.push({pos,id:ids.get(id),tile:tile?Uint8Array.from(tile):null});
    }
    let entities;
    if(Array.isArray(withEntities)){
      const rows=this.selectedEntityRows(withEntities);
      for(const {row} of rows)row.pos.forEach((v,i)=>{const p=Math.floor(v);lo[i]=Math.min(lo[i],p);hi[i]=Math.max(hi[i],p);});
      entities=rows.map(({row})=>packEntity(row,row.pos.map((v,i)=>v-lo[i]),stripEntityIdentity(row.nbt)));
    }else entities=withEntities?this.copyEntities(region??{lo,hi}):[];
    for(const raw of entities)bytes+=raw.length;
    if(!blocks.length&&!entities.length)fail('选区内没有可复制的方块或实体记录。');
    if(bytes>MAX_CLIP_BYTES)fail('临时模板超过 16 MiB，请缩小选区');
    for(const b of blocks)b.pos=b.pos.map((n,a)=>n-lo[a]);
    return {blocks,states,entities,bytes,size:hi.map((n,a)=>n-lo[a]+1),dv:this.dv,modern:this.palettes[palette].modern??this.dv>=5023};
  }
  entityEntries(){
    const field=this.fields.get('entities');if(field?.type!==9)return [];
    const r=new Reader(this.b,field.at),kind=r.byte(),n=r.len();if(kind!==10)return [];
    const rows=[];for(let i=0;i<n;i++){const at=r.p;r.skipTag(10);rows.push(this.entityEdits.get(i)??this.b.subarray(at,r.p));}return rows;
  }
  selectedEntityRows(refs){
    if(!Array.isArray(refs)||refs.length>512)fail('一次最多选择 512 个实体');
    if(!refs.length)return [];
    const rows=this.entityEntries(),seen=new Set();
    return refs.map(ref=>{
      const index=ref?.index,row=Number.isInteger(index)&&rows[index]?entityView(rows[index]):null;
      if(!row||seen.has(index)||row.revision!==ref.revision)fail('选区中的实体已变更，请重新框选');
      seen.add(index);return {index,row};
    });
  }
  entityList(){
    if(this._entityList)return this._entityList;
    this._entityList=this.entityEntries().slice(0,8192).flatMap((raw,index)=>{
      const row=entityView(raw);if(!row)return [];const {pos,id,rotation,rotationMode,baby,revision,invisible,variant,profile,hanging}=row;return [{index,pos,id,rotation,rotationMode,baby,revision,invisible,variant,profile,hanging}];
    });return this._entityList;
  }
  entityDetails(index){
    const raw=this.entityEntries()[index],row=raw&&entityView(raw);if(!row)fail('实体不存在或数据格式不受支持');
    return {index,id:row.id,pos:row.pos,revision:row.revision,dv:this.dv,
      text:new Reader(row.nbt).snbt(10,0,{n:0,mixed:mixedLists(this.dv)})};
  }
  copyEntities(region,countOnly=false){
    if(!region||!Array.isArray(region.lo)||!Array.isArray(region.hi)||region.lo.length!==3||region.hi.length!==3)return countOnly?0:[];
    const {lo,hi}=region;if(!lo.every((n,i)=>Number.isFinite(n)&&n<=hi[i]))return countOnly?0:[];
    const matching=this.entityList().filter(row=>row.pos.every((n,i)=>n>=lo[i]&&n<hi[i]+1));
    if(countOnly)return matching.length;
    if(matching.length>512)fail('一次最多复制 512 个实体');
    const rows=this.entityEntries();return matching.map(({index})=>{
      const row=entityView(rows[index]),pos=row.pos.map((v,i)=>v-lo[i]);return packEntity(row,pos,stripEntityIdentity(row.nbt));});
  }
  copyEntity(index){
    const raw=this.entityEntries()[index],row=raw&&entityView(raw);if(!row)fail('请选择实体');
    const entity=packEntity(row,[.5,0,.5],stripEntityIdentity(row.nbt));
    if(entity.length>MAX_CLIP_BYTES)fail('实体 NBT 过大');
    return {blocks:[],states:[],entities:[entity],entityOnly:true,size:[1,1,1],bytes:entity.length,dv:this.dv,modern:true,entityId:row.id};
  }
  entityBounds(pos){
    if(!Array.isArray(pos)||pos.length!==3||!pos.every((n,i)=>Number.isFinite(n)&&n>=0&&n<this.size[i]))fail('实体位置超出结构边界');
  }
  withEntities(rows){
    if(rows.length>8192)fail('结构实体数量超过 8192');
    const raw=this.raw(true),r=new Reader(raw);r.byte();r.skipStr();const f=r.fields().get('entities'),parts=[listHeader(10,rows.length),...rows];
    return updated(raw,[f?{...f,payload:parts}:{at:raw.length-1,end:raw.length-1,payload:[flag(9),utf('entities'),...parts]}]);
  }
  entityLayout(q){
    const rows=this.entityEntries();let index=q.index,row=null,nbt;
    if(q.action==='add'){
      index=rows.length;
      if(!(q.summoned instanceof Uint8Array)||q.summoned.length>256*1024)fail('缺少原版 /summon 初始化数据');
      const r=new Reader(Buffer.from(q.summoned));if(r.byte()!==10)fail('原版实体 NBT 格式无效');r.skipStr();
      nbt=r.b.subarray(r.p);if(entityId(nbt)!==q.id)fail('原版实体 ID 与选择不符');
      nbt=stripEntityIdentity(nbt);
    }else{
      row=Number.isInteger(index)&&rows[index]?entityView(rows[index]):null;
      if(!row||q.revision!==row.revision)fail('实体已变更，请重新选取');
      if(q.action==='delete'){
        rows.splice(index,1);
        return {raw:this.withEntities(rows),active:q.palette,entity:null};
      }
      nbt=row.nbt;
    }
    const pos=['nbt','rotate'].includes(q.action)?row.pos:q.pos;this.entityBounds(pos);
    let rotation;
    if(q.action==='nbt'){
      if(q.text!==undefined){const value=parse(q.text,utf,mixedLists(this.dv));if(value.type!==10)fail('实体 NBT 必须是 compound');nbt=value.data;}
      else if(q.fields!==undefined)nbt=editNbtFields(nbt,q.fields,this.dv,['id','Pos']);
      else{
        if(!Array.isArray(q.edits)||!q.edits.length||q.edits.length>128)fail('实体字段数量无效');
        let chars=0;
        for(const e of q.edits){const path=tilePath(e.path);if(path[0]==='Pos')fail('请在位置栏移动实体');
          chars+=e.text?.length??0;if(chars>256*1024)fail('本次编辑超过 256 KiB');
          const old=compoundFieldAt(nbt,path),v=e.remove?null:parse(e.text,utf,mixedLists(this.dv));
          if(v&&((old&&v.type!==old.type)||e.expectedType!==undefined&&v.type!==e.expectedType))fail('实体字段类型不匹配；请用高级 SNBT 更改类型。');
          nbt=editCompound(nbt,path,v);
        }
      }
      entityId(nbt);
    }else if(q.action==='rotate'){
      if(row.rotationMode!=='free')fail('此实体不支持连续旋转');
      if(!Number.isFinite(q.yaw)||Math.abs(q.yaw)>180)fail('实体水平旋转角度超出范围');
      if(q.yaw===row.rotation[0])return null;
      rotation=[q.yaw,row.rotation[1]];
    }else if(!['add','move'].includes(q.action))fail('未知实体操作');
    const next=packEntity(row,pos,nbt,rotation);
    if(row&&next.equals(row.raw))return null;
    rows[index]=next;
    return {raw:this.withEntities(rows),active:q.palette,entity:index};
  }
  pasteEntities(clip,origin,axes){
    if(!Array.isArray(origin)||origin.length!==3||!origin.every(Number.isSafeInteger))fail('无效的实体放置点');
    orientationTurns(axes);
    if(axes[1][1]!==1)fail('含实体的蓝图仅可绕 Y 轴旋转');
    const rows=this.entityEntries();for(const data of clip.entities){const r=entityTransform(Buffer.from(data),origin,axes);this.entityBounds(r.pos);rows.push(r.raw);}
    return this.withEntities(rows);
  }
  destinationGuard(q,overwrite,ignoreFluids=false){
    const ids=q.overwriteIds??[];
    if(overwrite&&(!Array.isArray(ids)||ids.length>256||ids.some(id=>typeof id!=='string'||id.length>160||!/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(id))))fail('移动覆盖白名单无效');
    const whitelist=overwrite?new Set(ids):null;
    return existing=>{
      if(!existing)return;
      // A destination is occupied if any variant uses a protected block, even when the active variant uses air.
      const names=this.palettes.map((_,p)=>this.state((existing>>1)-1,p)?.name).filter(name=>name&&!AIR.has(name)&&!(ignoreFluids&&FLUID.has(name)));
      if(!(existing&1)&&!names.length)return;
      if(!overwrite)fail(q.tool==='paste'?'蓝图落点已有方块，未粘贴。请调整位置或开启移动覆盖。':'目标位置有未选中的方块，未写入任何修改');
      const protectedName=whitelist.size&&names.find(name=>!whitelist.has(name));
      if(protectedName)fail(`目标方块 ${protectedName} 不在移动覆盖白名单中，整个操作已取消`);
      if((existing&1)&&q.allowNbt!==true)fail('目标位置有方块实体。若确实要丢弃它的数据，请先开启“允许丢弃目标方块实体数据”');
    };
  }
  paste(clip,origin,axes,q={}){
    if(!clip||!Array.isArray(origin)||origin.length!==3||!origin.every(Number.isSafeInteger))fail('无效的临时模板或放置点');
    const turns=orientationTurns(axes);
    if(clip.entities?.length&&axes[1][1]!==1)fail('含实体的蓝图仅可绕 Y 轴旋转');
    const mapped=new Map(),added=[],changes=[],tiles=[],selection=[];let limited=0,index;
    const ignoreFluids=q.ignoreFluids===true,checkDestination=this.destinationGuard({...q,tool:'paste'},q.moveOverwrite===true,ignoreFluids);
    for(const b of clip.blocks){
      if(ignoreFluids&&FLUID.has(clip.states[b.id].name))continue;
      const p=origin.map((n,i)=>n+axes.reduce((v,a,j)=>v+a[i]*b.pos[j],0)),c=this.cell(p),old=this.at(c);
      checkDestination(old);
      if(!mapped.has(b.id)){
        let state=clip.states[b.id],limited=false;
        for(const [a,n] of turns){const next=rotateState(state,a,n,this.gameCatalog);state=next.state;limited||=Boolean(next.limited);}
        const key=stateKey(state);
        if(!index){index=new Map();for(let n=0;n<this.paletteCount+this.extra.length;n++){
          const k=stateKey(this.state(n));if(this.palettes.every((_,p)=>stateKey(this.state(n,p))===k))index.set(k,n);
        }}
        let id=index.get(key);
        if(id===undefined){id=this.paletteCount+this.extra.length+added.length;if(id>=MAX_STATES)fail('调色板已达到状态上限');added.push({id,state});index.set(key,id);}
        mapped.set(b.id,{id,limited});
      }
      const row=mapped.get(b.id);if(row.limited)limited++;
      const tile=b.tile?relocateTile(Buffer.from(b.tile.buffer,b.tile.byteOffset,b.tile.byteLength),p):null;
      const next=(row.id+1)*2+Number(Boolean(tile));
      if(tile||(old&1))tiles.push([c,this.tiles.get(c)??null,tile]);
      if(old!==next||tile||(old&1))changes.push(c,old,next);
      selection.push(c);
    }
    if(!selection.length&&!q.allowEmpty)fail('忽略流体后没有可放置的方块');
    const packed=Uint32Array.from(changes),patch=added.length?added:null;
    return {changes:packed,tiles,added:patch,selection,limited,data:this.apply(packed,true,tiles,patch)};
  }
  edit(q,filter){
    if(q.tool==='move'||q.tool==='extrude'||q.tool==='rotate')return this.transform(q);
    if(q.tool==='tile')return this.editTile(q);
    if(q.tool==='tileInit')return this.initTile(q.cell);
    if(q.tool==='state')return this.editBlockState(q);
    const tools=['place','paint','erase','fill'];if(!tools.includes(q.tool))fail('未知编辑工具');
    const mode=q.commandMode,command=mode!==undefined,shape=mode==='hollow'||mode==='outline';
    if(command&&(q.tool!=='fill'||!q.box||!['replace','keep','strict','destroy','hollow','outline'].includes(mode)))fail('放置模式无效');
    const cells=new Set();const [w,,d]=this.size;let lo,hi;
    if(q.box){
      if(!Array.isArray(q.box)||q.box.length!==2)fail('无效选区');
      const [a,b]=q.box;this.cell(a);this.cell(b);lo=a.map((v,i)=>Math.min(v,b[i]));hi=a.map((v,i)=>Math.max(v,b[i]));
      const n=hi.reduce((v,end,i)=>v*(end-lo[i]+1),1);if(n>MAX_EDIT)fail('选区过大，请分批编辑（每次最多 262144 格）');
      for(let y=lo[1];y<=hi[1];y++)for(let z=lo[2];z<=hi[2];z++)for(let x=lo[0];x<=hi[0];x++)cells.add(x+w*(z+d*y));
    }else{
      if(!Array.isArray(q.points)||q.points.length>MAX_EDIT)fail('无效的编辑坐标');
      for(const p of q.points){cells.add(this.cell(p));if(q.mx)cells.add(this.cell([w-1-p[0],p[1],p[2]]));if(q.mz)cells.add(this.cell([p[0],p[1],d-1-p[2]]));if(q.mx&&q.mz)cells.add(this.cell([w-1-p[0],p[1],d-1-p[2]]));}
    }
    if(cells.size>MAX_EDIT)fail('单次编辑过大');
    const pn=Number.isInteger(q.palette)&&q.palette>=0&&q.palette<this.palettes.length?q.palette:0;
    let id=q.state,st=null,air=-1;
    const states=[];
    const lookup=s=>{const key=stateKey(s);return pn===0?this.keys.get(key)??-1:this.paletteView(pn).findIndex(v=>stateKey(v)===key);};
    const add=s=>{const id=this.paletteCount+this.extra.length+states.length;if(id>=MAX_STATES)fail('调色板已达到状态上限');states.push({id,state:s});return id;};
    if(q.tool!=='erase'){
      if(typeof id==='object'){st=validateState(id);id=lookup(st);if(id>=0)st=null;}
      if(!st&&(!Number.isInteger(id)||id<0||!this.state(id,pn)))fail('请选择有效的方块');
      if(this.palettes.some((_,p)=>(st??this.state(id,p))?.name===STRUCTURE_VOID))fail('结构空位只能用擦除生成，不能作为画笔方块。');
    }
    if(mode==='hollow'){
      air=lookup(AIR_STATE);if(air>=0&&!this.palettes.every((_,p)=>this.state(air,p)?.name===AIR_STATE.name))air=-1;
    }
    const predicate=q.blockFilter&&validateState(q.blockFilter),tag=q.blockFilter?.tag===true;
    const wantNbt=q.blockFilter?.snbt!==undefined?commandCompound(q.blockFilter.snbt,this.dv):null;
    const props=Object.entries(predicate?.props??{});let budget=8_000_000;
    const spend=n=>{budget-=n;if(budget<0)fail('筛选的 NBT 比较次数过多，请缩小选区或简化条件。');};
    if(tag&&!filter)fail('缺少所选 JAR 的方块标签数据。');
    const configured=q.snbt!==undefined;
    let nextTile=q.tool==='erase'?null:this.defaultTile(id,st);
    if(configured){
      if(!command||!nextTile)fail('这个方块不支持方块实体 SNBT。');
      const bytes=commandCompound(q.snbt,this.dv),fields=new Reader(bytes).fields();
      nextTile=Buffer.concat([nextTile.subarray(0,-1),...[...fields].filter(([key])=>!tileIdentity.includes(key)).map(([,f])=>bytes.subarray(f.start,f.end)),flag(0)]);
    }
    const changes=[],tiles=[];let skipped=0,snbtBytes=0;
    for(const i of cells){
      const current=this.at(i),prev=(current>>1)-1,old=this.state(prev,pn),occupied=old&&!AIR.has(old.name);
      if(((q.tool==='place'||q.tool==='fill'&&(q.keepExisting===true||mode==='keep'))&&occupied)||(q.tool==='paint'&&!occupied)||(q.tool==='erase'&&!occupied&&q.eraseInvisible!==true))continue;
      const core=shape&&this.pos(i).every((v,a)=>lo[a]<v&&v<hi[a]);
      if(core&&mode==='outline'||filter&&!filter(this,i,pn,cells.size))continue;
      if(predicate){
        const state=!old||old.name===STRUCTURE_VOID?AIR_STATE:old;
        if(!tag&&state.name!==predicate.name||props.some(([k,v])=>(state.props[k]??(this.gameCatalog?.schema??stateSchema)[state.name]?.[k]?.default)!==v))continue;
        if(wantNbt){const bytes=this.tileAt(i)??this.defaultTile(prev);if(!bytes||!nbtMatches(10,wantNbt,bytes,spend))continue;}
      }
      const hasTile=Boolean(current&1),sameBlock=hasTile&&!core&&q.tool!=='erase'&&this.palettes.every((_,p)=>this.state(prev,p)?.name===(st??this.state(id,p))?.name);
      const keep=sameBlock&&mode!=='destroy'&&!configured;
      if(hasTile&&!keep&&!(configured&&sameBlock)&&!q.allowNbt){skipped++;continue;}
      const tile=core?null:nextTile;
      let target=core?air:id;
      if(q.tool!=='erase'&&target<0){
        if(core){if(st?.name===AIR_STATE.name&&Object.keys(st.props).length===0)air=id=id<0?add(st):id;else air=add(AIR_STATE);target=air;}
        else target=id=add(st);
      }
      const next=q.tool==='erase'?0:(target+1)*2+Number(keep||Boolean(tile));
      const tileChanged=!keep&&(tile?(!hasTile||!tile.equals(this.tileAt(i))):hasTile);
      if(configured&&tileChanged&&tile){snbtBytes+=tile.length;if(snbtBytes>MAX_CLIP_BYTES)fail('本次写入的方块实体 SNBT 超过 16 MiB，请分批编辑。');}
      if(next!==current||tileChanged){changes.push(i,current,next);if(tileChanged)tiles.push([i,this.tiles.get(i)??null,tile]);}
    }
    if(command&&!changes.length)fail(skipped?'目标方块实体受保护；请检查覆盖设置。':'指令未改变任何方块。');
    const packed=Uint32Array.from(changes),added=states.length>1?states:states[0]??null;
    return {changes:packed,tiles,skipped,added,data:this.apply(packed,true,tiles,added)};
  }

  editBlockState(q){
    const c=q.cell,p=q.palette??0;
    if(q.box||q.points||!Number.isInteger(c)||c<0||c>=this.volume||!this.palettes[p])fail('只能修改一个方块的状态');
    const v=this.at(c),old=(v>>1)-1,st=this.state(old,p);
    if(!st||AIR.has(st.name))fail('先取样一个方块');
    if(q.expected!==old)fail('该方块已被修改，请重新取样');
    const props=Object.assign(Object.create(null),st.props),edits=q.edits??[q],seen=new Set();
    if(!Array.isArray(edits)||!edits.length||edits.length>32)fail('方块状态改动数量无效');
    for(const edit of edits){
      if(!edit||typeof edit.key!=='string'||!/^[a-z0-9_]+$/.test(edit.key)||seen.has(edit.key))fail('无效或重复的属性名称');
      seen.add(edit.key);
      if(edit.value===null){if(!Object.hasOwn(props,edit.key))fail('没有这个属性');delete props[edit.key];}
      else props[edit.key]=edit.value;
    }
    const next=validateState({name:st.name,props});
    if(stateKey(st)===stateKey(next))return {changes:new Uint32Array(),data:'',skipped:0,added:null};
    const rows=this.palettes.map((_,pn)=>pn===p?next:this.state(old,pn)),keys=rows.map(stateKey);
    let id=this.paletteCount+this.extra.length,added=null;
    for(let i=0;i<id;i++)if(this.palettes.every((_,pn)=>stateKey(this.state(i,pn))===keys[pn])){id=i;break;}
    if(!this.state(id,p)){if(id>=MAX_STATES)fail('调色板已达到状态上限');added={id,state:rows[0],variants:rows};}
    const changes=Uint32Array.of(c,v,(id+1)*2+(v&1));
    return {changes,data:this.apply(changes,true,[],added),skipped:0,added};
  }
  transform(q){
    const turn=q.tool==='rotate',move=q.tool!=='extrude',d=q.delta;
    let axis,n=1,step,pivot,turns;
    if(turn){
      ({axis,pivot}=q);turns=((q.turns%4)+4)%4;
      if(![0,1,2].includes(axis)||!Number.isInteger(q.turns)||Math.abs(q.turns)>3||!turns||!Array.isArray(pivot)||pivot.length!==3||!pivot.every((v,i)=>typeof v==='number'&&Number.isInteger(v*2)&&v>=0&&v<=this.size[i])||(2*pivot[(axis+1)%3])%2!==(2*pivot[(axis+2)%3])%2)fail('无效的旋转轴或轴心');
    }else{
      if(!Array.isArray(d)||d.length!==3||!d.every(Number.isInteger)||d.filter(Boolean).length!==1)fail('请沿一个轴移动或挤出整格');
      axis=d.findIndex(Boolean);n=Math.abs(d[axis]);step=Math.sign(d[axis]);if(n>=this.size[axis])fail('移动或挤出距离超出结构范围');
    }
    const entityRows=this.selectedEntityRows(q.entitySelection??[]);
    if(entityRows.length&&(!move||turn&&axis!==1))fail('含实体的选区仅可平移或绕 Y 轴旋转');
    const axes=turn?[[1,0,0],[0,1,0],[0,0,1]].map(v=>rotate(v,axis,turns)):null;
    const entityChanges=[];
    for(const {index,row} of entityRows){
      const turnAt=(pos,center)=>rotate(pos.map((v,i)=>v+center-pivot[i]),axis,turns).map((v,i)=>v+pivot[i]-center);
      const pos=turn?turnAt(row.pos,0):row.pos.map((v,i)=>v+d[i]);this.entityBounds(pos);
      const yaw=((row.rotation[0]-turns*90+180)%360+360)%360-180;
      const bytes=packEntity(row,pos,row.nbt,turn&&row.rotationMode!=='fixed'?[yaw,row.rotation[1]]:null,axes,turn?turnAt(row.blockPos,.5):undefined);
      if(!bytes.equals(row.raw))entityChanges.push([index,this.entityEdits.get(index)??null,bytes]);
    }
    if(!Array.isArray(q.selection)||(!q.selection.length&&!entityRows.length)||q.selection.length>MAX_EDIT)fail('变换的选区无效');
    const selected=new Map(),pn=Number.isInteger(q.palette)&&this.palettes[q.palette]?q.palette:0;
    const includeInvisible=q.includeInvisible===true;
    for(const c of q.selection){
      if(!Number.isInteger(c)||c<0||c>=this.volume)fail('无效的选区坐标');
      const v=this.at(c);if(v?includeInvisible||!AIR.has(this.state((v>>1)-1,pn)?.name)||(v&1):move&&includeInvisible){if((v&1)&&(!move||!q.allowMoveNbt))fail(move?'选区包含方块实体。请先启用“允许移动方块实体”。':'不挤出方块实体，以免重复箱子内容等数据。');selected.set(c,v);}
    }
    if(!selected.size&&!entityRows.length)fail('选区没有可变换的方块');
    const checkDestination=this.destinationGuard(q,move&&q.moveOverwrite===true);
    const target=new Map(),writes=new Map(),targetTiles=new Map(),holes=new Set(),added=[];
    let index,limited=0;const mapped=new Map();
    const rotateValue=v=>{
      const old=(v>>1)-1;
      if(!mapped.has(old)){
        const results=this.palettes.map((_,p)=>rotateState(this.state(old,p),axis,turns,this.gameCatalog));
        const rows=results.map(r=>r.state),key=JSON.stringify(rows.map(stateKey));let id=old;
        if(rows.some((row,p)=>stateKey(row)!==stateKey(this.state(old,p)))){
          if(!index){index=new Map();for(let i=0;i<this.paletteCount+this.extra.length;i++)index.set(JSON.stringify(this.palettes.map((_,p)=>stateKey(this.state(i,p)))),i);}
          id=index.get(key);
          if(id===undefined){id=this.paletteCount+this.extra.length+added.length;if(id>=MAX_STATES)fail('调色板已达到状态上限');index.set(key,id);added.push({id,state:rows[0],variants:rows});}
        }
        mapped.set(old,{id,limited:results.some(r=>r.limited)});
      }
      const row=mapped.get(old);if(row.limited)limited++;
      return (row.id+1)*2+(v&1);
    };
    if(!move&&n*selected.size>MAX_EDIT*4)fail('挤出范围过大，请分几次操作');
    for(let k=move?n:1;k<=n;k++)for(const [c,v] of selected){
      let p=this.pos(c);
      if(turn)p=rotate(p.map((v,i)=>v+.5-pivot[i]),axis,turns).map((v,i)=>v+pivot[i]-.5);
      else p[axis]+=k*step;
      const x=this.cell(p);
      // A missing record can follow the selection, but must not erase the destination.
      if(!v){if(!this.at(x)||selected.has(x))holes.add(x);continue;}
      if(!move&&selected.has(x))continue;
      if(!selected.has(x))checkDestination(this.at(x));
      if(!target.has(x)){target.set(x,turn?rotateValue(v):v);if(v&1)targetTiles.set(x,relocateTile(this.tileAt(c),p));}
    }
    if(move){
      let air;
      for(const [c,v] of selected)if(v&&!target.has(c)){
        if(air===undefined){
          let id=0;const key=stateKey(AIR_STATE);
          for(;id<this.paletteCount+this.extra.length;id++)if(this.palettes.every((_,p)=>stateKey(this.state(id,p))===key))break;
          if(id===this.paletteCount+this.extra.length){id+=added.length;if(id>=MAX_STATES)fail('调色板没有空间加入空气');added.push({id,state:AIR_STATE});}
          air=(id+1)*2;
        }
        writes.set(c,air);
      }
    }
    for(const [c,v] of target)writes.set(c,v);
    if(writes.size>MAX_EDIT)fail('变换修改超过 262144 格');
    const changes=[],tiles=[];
    for(const [c,v] of writes){const old=this.at(c),nextTile=targetTiles.get(c)??null;
      const priorTile=(old&1)?this.tileAt(c):null;
      const changedTile=priorTile&&nextTile?!priorTile.equals(nextTile):priorTile!==nextTile;
      if(v!==old||changedTile)changes.push(c,old,v);
      if((old&1)||(v&1))tiles.push([c,this.tiles.get(c)??null,nextTile]);}
    const packed=Uint32Array.from(changes);
    const patch=added.length?added:null;
    return {changes:packed,tiles,skipped:0,limited,added:patch,entityChanges,data:this.apply(packed,true,tiles,patch,entityChanges),selection:[...new Set([...(move?holes:selected.keys()),...target.keys()])]};
  }
  apply(changes,after,tiles=[],added,entityChanges=[]){
    for(const row of Array.isArray(added)?added:added?[added]:[])if(!this.state(row.id)){
      if(row.id!==this.paletteCount+this.extra.length)fail('无法恢复方块状态，请重新打开文件');
      this.keys.set(stateKey(row.state),row.id);this.extra.push(row.state);if(row.variants)this.extraVariants.set(row.id,row.variants);
    }
    for(const [cell,before,next] of tiles){const bytes=after?next:before;if(bytes)this.tiles.set(cell,Buffer.from(bytes));else this.tiles.delete(cell);}
    for(const [index,before,next] of entityChanges){const bytes=after?next:before;if(bytes)this.entityEdits.set(index,Buffer.from(bytes));else this.entityEdits.delete(index);}
    if(entityChanges.length)this._entityList=null;
    const buf=Buffer.allocUnsafe(changes.length/3*8);for(let j=0,k=0;j<changes.length;j+=3,k+=8){const i=changes[j],v=changes[j+(after?2:1)];this.set(i,v);buf.writeUInt32LE(i,k);buf.writeUInt32LE(v,k+4);}return buf.toString('base64');
  }
  defaultTileType(id,custom=null){
    if(this.dv!==null&&this.dv<1519)return null;
    const types=this.gameCatalog?.tiles??tileTypes,first=types[(custom??this.state(id))?.name];
    return typeof first==='string'&&this.palettes.every((_,p)=>types[(custom??this.state(id,p))?.name]===first)?first:null;
  }
  defaultTile(id,custom){const type=this.defaultTileType(id,custom);return type?freshTile(type):null;}
  initTile(cell){
    if(!Number.isInteger(cell)||cell<0||cell>=this.volume)fail('方块坐标无效');
    const value=this.at(cell);if(!value||(value&1))fail('此位置不是缺少 NBT 的方块实体');
    const tile=this.defaultTile((value>>1)-1);if(!tile)fail('此方块或调色板变体不支持初始化方块实体');
    const changed=Uint32Array.of(cell,value,value|1),tiles=[[cell,null,tile]];
    return {changes:changed,tiles,added:null,skipped:0,data:this.apply(changed,true,tiles)};
  }
  tileAt(cell){
    if(!Number.isInteger(cell)||cell<0||cell>=this.volume||!(this.at(cell)&1))return null;
    if(this.tiles.has(cell))return this.tiles.get(cell);
    if(!this.index[cell])fail('此方块实体数据缺失');
    const f=new Reader(this.b,this.blockStart[this.index[cell]-1]).fields().get('nbt');
    return f?this.b.subarray(f.at,f.end):null;
  }
  blockData(cell){const tile=this.tileAt(cell);return tile?new Reader(tile).display(10):null;}
  tileInfo(cell){
    const bytes=this.tileAt(cell);
    if(!bytes){const type=Number.isInteger(cell)&&cell>=0&&cell<this.volume?this.defaultTileType((this.at(cell)>>1)-1):null;return type?{canInitialize:true,type}:null;}
    const f=new Reader(bytes).fields();
    const fields=[...f].map(([name,e])=>({name,type:e.type}));
    let text=null;
    if(bytes.length<=256*1024)try{
      text=new Reader(bytes).snbt(10,0,{n:0,max:3000,pretty:true,mixed:mixedLists(this.dv)});
      if(text.length>256*1024)text=null;
    }catch{}
    return {fields,data:this.blockData(cell),dv:this.dv,text,revision:createHash('sha256').update(bytes).digest('hex')};
  }
  tileField(cell,path){return compoundFieldAt(this.tileAt(cell),tilePath(path));}
  tileValue(cell,path){const f=this.tileField(cell,path);return f?{type:f.type,text:new Reader(f.bytes).snbt(f.type,0,{n:0,mixed:mixedLists(this.dv)})}:null;}
  editTile(q){
    const c=q.cell,bytes=this.tileAt(c);if(!bytes)fail('选中位置没有方块实体');
    let data=bytes;
    if(q.fields!==undefined){
      if(q.revision!==createHash('sha256').update(bytes).digest('hex'))fail('方块实体已变更，请重新取样');
      data=editNbtFields(bytes,q.fields,this.dv,tileIdentity,true);
    }else{
      const changesToApply=q.edits??[q];
      if(!Array.isArray(changesToApply)||!changesToApply.length||changesToApply.length>128)fail('方块实体改动数量无效');
      const seen=new Set();let textSize=0;
      for(const edit of changesToApply){
        const path=tilePath(edit?.path);if(tileIdentity.includes(path[0]))fail('方块实体 ID 和位置不能在此改写');
        if(seen.has(edit.path))fail('方块实体字段重复');seen.add(edit.path);
        const old=compoundFieldAt(data,path);if(edit.remove&&!old)continue;
        textSize+=edit.text?.length||0;if(textSize>256*1024)fail('本次方块实体编辑超过 256 KiB');
        const value=edit.remove?null:parse(edit.text,utf,mixedLists(this.dv));
        if(value&&edit.expectedType!==undefined&&value.type!==edit.expectedType)fail('请输入与该字段标注匹配的 NBT 类型');
        if(value&&edit.allowTypeChange!==true&&old&&old.type!==value.type)fail('标签类型改变。若确实要改类型，请在高级 SNBT 中勾选“允许更改标签类型”。');
        data=editCompound(data,path,value);
      }
    }
    if(data.equals(bytes))return {changes:new Uint32Array(),tiles:[],data:'',skipped:0,added:null};
    const v=this.at(c),changes=Uint32Array.of(c,v,v),tiles=[[c,this.tiles.get(c)??null,data]];
    return {changes,tiles,data:this.apply(changes,true,tiles),skipped:0,added:null};
  }
  snbt(){
    const raw=this.raw(true);
    if(raw.length>SNBT_TEXT)fail('结构太大，无法打开全文 SNBT。仍可使用 3D 编辑或单独编辑方块实体。');
    const reader=new Reader(raw);reader.byte();reader.skipStr();
    const text=reader.snbt(10,0,{n:0,max:SNBT_NODES,pretty:true,mixed:mixedLists(this.dv)});
    if(text.length>SNBT_TEXT)fail('格式化后的 SNBT 超过 4 MiB 文本限制。');
    return {text,revision:createHash('sha256').update(raw).digest('hex')};
  }
  replaceSnbt(q){
    const base=this.raw(true);
    if(q.revision!==createHash('sha256').update(base).digest('hex'))fail('结构已有其他更改。请先复制当前草稿，再重新读取 SNBT。');
    const root=parse(q.text,utf,mixedLists(this.dv),SNBT_TEXT,SNBT_NODES);
    if(root.type!==10)fail('结构 SNBT 的根必须是 compound：{…}');
    const r=new Reader(base);r.byte();r.skipStr();const raw=Buffer.concat([base.subarray(0,r.p),root.data]);
    if(raw.equals(base))return null;
    const next=new Structure(null,raw,this.zip);
    if(next.dv!==this.dv)fail('SNBT 不会转换结构版本，请保留原有的 DataVersion。');
    return {raw,active:Math.min(q.palette,next.palettes.length-1)};
  }
  layout(q){
    if(q.kind==='snbt')return this.replaceSnbt(q);
    if(q.kind==='entity')return this.entityLayout(q);
    if(q.kind==='size')return this.resize(q);
    if(q.kind==='paletteClean')return this.cleanPalette(q.palette);
    const n=this.palettes.length,where=q.palette;
    if(!Number.isInteger(where)||where<0||where>=n)fail('找不到要编辑的调色板');
    if(q.kind==='paletteAdd'&&n>=64)fail('最多支持 64 套调色板');
    if(q.kind==='paletteDelete'&&n===1)fail('至少保留一套调色板');
    if(!['paletteAdd','paletteDelete','paletteState'].includes(q.kind))fail('未知模板操作');
    const src=this.raw(true),s=new Structure(null,src,this.zip);const pp=s.palettes.map(p=>Buffer.concat([listHeader(10,p.count),src.subarray(p.at,p.end)]));
    let active=where;
    if(q.kind==='paletteAdd'){pp.push(pp[where]);active=n;}
    if(q.kind==='paletteDelete'){pp.splice(where,1);active=Math.min(where,pp.length-1);}
    if(q.kind==='paletteState'){
      const id=q.stateId, st=validateState(q.state);if(!Number.isInteger(id)||id<0||id>=s.paletteCount)fail('请先选择需要更改的状态索引');
      if(st.name===STRUCTURE_VOID)fail('结构空位只能用擦除生成，不能写入调色板槽位。');
      const pal=s.palettes[where];if(stateKey(pal.states[id])===stateKey(st))return null;
      if(pal.states[id].name!==st.name)for(const v of s.blockValue)if((v&1)&&((v>>1)-1)===id)fail('此状态绑定方块实体，不能改成不同方块 ID');
      const r=new Reader(src,pal.at);for(let i=0;i<id;i++)r.skipTag(10);const a=r.p;r.skipTag(10);
      pp[where]=Buffer.concat([listHeader(10,pal.count),src.subarray(pal.at,a),paletteBytes(st,pal.modern??(s.dv>=5023)),src.subarray(r.p,pal.end)]);
    }
    const payload=pp.length===1?[pp[0]]:[listHeader(9,pp.length),...pp];const name=pp.length===1?'palette':'palettes';
    let writes=[{at:s.palField.start,end:s.palField.end,payload:[flag(9),utf(name),...payload]}];
    const alternate=s.fields.get(name==='palette'?'palettes':'palette');if(alternate&&alternate!==s.palField)writes.push({at:alternate.start,end:alternate.end,payload:[]});
    return {raw:updated(src,writes),active};
  }
  cleanPalette(active){
    if(!this.palettes[active])fail('找不到当前调色板');
    const src=this.raw(true),s=new Structure(null,src,this.zip),used=new Uint8Array(s.paletteCount);
    for(const v of s.blockValue)used[(v>>1)-1]=1;
    const count=used.reduce((n,v)=>n+v,0),removed=s.paletteCount-count;if(!removed)return null;
    const remap=new Int32Array(used.length),payload=s.multi?[listHeader(9,s.palettes.length)]:[];
    let next=0;for(let i=0;i<used.length;i++)if(used[i])remap[i]=next++;
    for(const pal of s.palettes){
      const r=new Reader(src,pal.at);payload.push(listHeader(10,count));
      for(const keep of used){const a=r.p;r.skipTag(10);if(keep)payload.push(src.subarray(a,r.p));}
    }
    const out=Buffer.from(src);
    for(let i=0;i<s.blockValue.length;i++){
      const old=(s.blockValue[i]>>1)-1;if(old===remap[old])continue;
      const row=new Reader(src,s.blockStart[i]);const field=row.fields().get('state');out.writeInt32BE(remap[old],field.at);
    }
    return {raw:updated(out,[{...s.palField,payload}]),active,removed};
  }
  grow(size,offset){
    dimensions(size);
    const raw=Buffer.from(this.raw(true)),root=new Reader(raw);root.byte();root.skipStr();const fields=root.fields();
    const shift=(field,block=false)=>{
      if(field?.type!==9)return null;
      const r=new Reader(raw,field.at),kind=r.byte();if(r.len()!==3)return null;
      if(kind===3){const at=r.p,p=[r.int(),r.int(),r.int()].map((v,i)=>v+offset[i]);p.forEach((v,i)=>raw.writeInt32BE(v,at+i*4));return p;}
      if(kind===6&&!block)for(let i=0;i<3;i++){const at=r.p+i*8;raw.writeDoubleBE(raw.readDoubleBE(at)+offset[i],at);}
      return null;
    };
    if(offset.some(Boolean))for(const key of ['blocks','entities']){
      const field=fields.get(key);if(field?.type!==9)continue;
      const r=new Reader(raw,field.at),type=r.byte(),n=r.len();if(type!==10)continue;
      for(let i=0;i<n;i++){
        const f=r.fields(),pos=shift(f.get('pos'),key==='blocks');
        if(key==='entities'){shift(f.get('blockPos'));continue;}
        const tile=f.get('nbt');if(pos&&tile?.type===10){
          const coords=new Reader(raw,tile.at).fields();for(const [i,key] of ['x','y','z'].entries())if(coords.get(key)?.type===3)raw.writeInt32BE(pos[i],coords.get(key).at);
        }
      }
    }
    size.forEach((v,i)=>raw.writeInt32BE(v,fields.get('size').at+5+i*4));
    const next=new Structure(null,raw,this.zip);next.gameCatalog=this.gameCatalog;return next;
  }
  resize(q){
    const size=q.size,volume=dimensions(size);if(size.every((v,i)=>v===this.size[i]))return null;
    const src=this.raw(true),s=new Structure(null,src,this.zip);const keep=p=>p.every((v,i)=>v>=0&&v<size[i]);
    const wins=[],ef=s.fields.get('entities'),parts=[];let cut=0,cutTiles=0,cutEntities=0;
    if(size.some((v,i)=>v<s.size[i])){
      let start=s.blockStart[0];
      for(let i=0;i<s.blockCell.length;i++)if(!keep(s.pos(s.blockCell[i]))){parts.push(src.subarray(start,s.blockStart[i]));start=s.blockStart[i+1];cut++;if(s.blockValue[i]&1)cutTiles++;}
      parts.push(src.subarray(start,s.blockStart[s.blockCell.length]));
      if(ef?.type===9){
        const r=new Reader(src,ef.at),type=r.byte(),count=r.len(),parts=[];
        if(type===10)for(let i=0;i<count;i++){
          const a=r.p,f=r.fields();const e=f.get('pos')||f.get('blockPos');let p=null;
          if(e?.type===9){const rr=new Reader(src,e.at),t=rr.byte(),k=rr.len();if(k===3&&t===3)p=[rr.int(),rr.int(),rr.int()];
            else if(k===3&&t===6){rr.need(24);p=[0,8,16].map(o=>src.readDoubleBE(rr.p+o));}}
          if(p?.every(Number.isFinite)&&!keep(p))cutEntities++;else parts.push(src.subarray(a,r.p));
        }
        if(cutEntities)wins.push({...ef,payload:[listHeader(10,count-cutEntities),...parts]});
      }
    }
    if((cut||cutEntities)&&!q.crop)return {confirm:{size,cut,cutTiles,cutEntities}};
    const [w,h,d]=size,[ow,oh,od]=size.map((n,i)=>Math.min(n,s.size[i])),extra=volume-ow*oh*od;
    if(!parts.length)parts.push(src.subarray(s.blockStart[0],s.blockStart[s.blockCell.length]));
    if(extra){
      const air={name:'minecraft:air',props:{}},key=stateKey(air);
      let id=s.palettes[0].states.findIndex((st,i)=>stateKey(st)===key&&s.palettes.every(p=>stateKey(p.states[i])===key));
      if(id<0){
        id=s.paletteCount;if(id>=MAX_STATES)fail('调色板没有空间加入空气，无法扩展结构');
        const payload=s.multi?[listHeader(9,s.palettes.length)]:[];
        for(const p of s.palettes)payload.push(listHeader(10,p.count+1),src.subarray(p.at,p.end),paletteBytes(air,p.modern??s.dv>=5023));
        wins.push({...s.palField,payload});
      }
      const block=simpleBlock([0,0,0],id),length=extra*block.length;
      if(src.length-(s.blocksField.end-s.blockStart[0])+parts.reduce((n,b)=>n+b.length,0)+length>MAX_BYTES)fail('添加空气后超过 256 MiB，请缩小扩展范围');
      const fill=Buffer.allocUnsafe(length);let offset=0;
      // Skip the retained prism, including its intentionally unwritten cells.
      for(let y=0;y<h;y++)for(let z=0;z<d;z++)for(let x=y<oh&&z<od?ow:0;x<w;x++){
        block.copy(fill,offset);const pos=offset+11; // compound's named pos list header
        fill.writeInt32BE(x,pos);fill.writeInt32BE(y,pos+4);fill.writeInt32BE(z,pos+8);offset+=block.length;
      }
      parts.push(fill);
    }
    if(cut||extra)wins.push({...s.blocksField,payload:[listHeader(10,s.blockCell.length-cut+extra),...parts]});
    wins.push({...s.fields.get('size'),payload:[posBytes(size)]});
    return {raw:updated(src,wins),active:q.palette};
  }
  raw(forcePalette=false){
    const entityWrite=this.entityEdits.size?{...this.fields.get('entities'),payload:[listHeader(10,this.entities),...this.entityEntries()]}:null;
    if(!this.delta.size&&!this.tiles.size&&(!forcePalette||!this.extra.length))return entityWrite?updated(this.b,[entityWrite]):this.b;
    const n=this.blockCell.length, parts=[];let count=n, start=this.blockStart[0];
    const b=this.b;
    for(let i=0;i<n;i++){
      const cell=this.blockCell[i];if(!this.delta.has(cell)&&!this.tiles.has(cell))continue;
      const v=this.at(cell);
      const a=this.blockStart[i],end=this.blockStart[i+1];parts.push(b.subarray(start,a));start=end;
      if(!v){count--;continue;}
      const p=[ ]; const r=new Reader(b,a);let t;
      while((t=r.byte())!==0){const from=r.p-1,k=r.str(),at=r.p;r.skipTag(t);
        if(k==='state')p.push(b.subarray(from,at),int((v>>1)-1));else if(k!=='nbt')p.push(b.subarray(from,r.p));
      }
      if(v&1)p.push(named(10,'nbt',this.tileAt(cell)));
      parts.push(Buffer.concat([...p,flag(0)]));
    }
    parts.push(b.subarray(start,this.blockStart[n]));
    for(const [i,v] of this.delta)if(!this.index[i]&&v){count++;parts.push(simpleBlock(this.pos(i),(v>>1)-1,(v&1)?this.tileAt(i):null));}
    const writes=[{...this.blocksField,payload:[listHeader(10,count),...parts]}];
    if(entityWrite)writes.push(entityWrite);
    if(this.extra.length){
      const payload=this.multi?[listHeader(9,this.palettes.length)]:[];
      for(const [p,pal] of this.palettes.entries())payload.push(listHeader(10,pal.count+this.extra.length),b.subarray(pal.at,pal.end),...this.extra.map((s,i)=>paletteBytes(this.extraVariants.get(this.paletteCount+i)?.[p]??s,pal.modern??this.dv>=5023)));
      writes.push({...this.palField,payload});
    }
    return updated(b,writes);
  }
  async saveRaw(buf){return this.zip==='raw'?buf:await codecs[this.zip](buf,{level:3});}
  async serialize(){if(!this.delta.size&&!this.tiles.size&&!this.entityEdits.size&&this.original)return this.original;return this.saveRaw(this.raw());}
}
module.exports={Structure,create,AIR,validateState,dimensions,MAX_EDIT,clipBytes,clipThumb,clipEntityPreview,clipHeadProfiles};
