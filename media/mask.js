export const predicateFields={
 true:[], matching_blocks:['offset','blocks'],matching_block_tag:['offset','tag'], matching_fluids:['offset','fluids'],
 solid:['offset'],replaceable:['offset'],has_sturdy_face:['offset','direction'],height_range:['min_inclusive','max_inclusive'],
 volume_match:['min','max','match'],all_of:['predicates'],any_of:['predicates'],not:['predicate']
};
export const directions=['down','up','north','south','west','east'];
const anchors=['absolute','above_bottom','below_top'];
const blocked=new Set(['unobstructed','matching_biomes','would_survive','inside_world_bounds']);
const fluids=['minecraft:empty','minecraft:water','minecraft:flowing_water','minecraft:lava','minecraft:flowing_lava'];
export const maskStateKey=s=>s.name+'\0'+JSON.stringify(Object.keys(s.props||{}).sort().map(k=>[k,s.props[k]]));
export const maskAir={name:'minecraft:air',props:{}};
const fail=msg=>{throw new Error(msg);};
const idValid=/^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
function id(s){if(typeof s!=='string'||s.length>160||!idValid.test(s)||s.split(/[:/]/).some(k=>!k||k==='.'||k==='..'))fail('方块或标签 ID 无效：'+String(s));return s.includes(':')?s:'minecraft:'+s;}
export function compileMask(raw,catalog){
 if(!catalog)fail('方块掩码需要在设置里选择原版客户端 JAR');
 let nodes=0;const tags=new Map(),states=new WeakMap();
 const registered=(k,kind)=>kind==='fluid'?fluids.includes(k):!catalog.traits||Object.hasOwn(catalog.traits,k);
 function tag(ref,kind,stack=[],allowMissing=false){
  const key=id(ref.replace(/^#/,'')),cache=kind+':'+key;if(stack.includes(key)||stack.length>=64)fail('JAR 标签存在循环或嵌套过深：#'+key);
  if(tags.has(cache))return tags.get(cache);
  const entries=catalog.tags?.[kind]?.[key];if(!Array.isArray(entries)){if(allowMissing)return new Set();fail('所选 JAR 中找不到标签 #'+key);}
  const result=new Set();for(const e of entries){const value=typeof e==='string'?e:e?.id;if(typeof value!=='string')fail('JAR 标签条目无效：#'+key);
   if(!value.startsWith('#')){const entry=id(value);if(registered(entry,kind))result.add(entry);else if(e?.required!==false)fail('JAR 标签含未注册的 ID：'+entry);}
   else{const child=id(value.slice(1));if(e?.required===false&&!Object.hasOwn(catalog.tags[kind],child))continue;for(const v of tag(child,kind,[...stack,key]))result.add(v);}
  }
  tags.set(cache,result);return result;
 }
 function set(value,kind){
  if(typeof value==='string'&&value.startsWith('#'))return tag(value,kind);
  const list=Array.isArray(value)?value:[value];if(list.length>256)fail('方块或流体列表最多 256 项');
  return new Set(list.map(v=>{
   if(typeof v==='string'&&v.startsWith('#'))fail('标签必须是单独的 "#命名空间:标签" 字符串，不能放在数组里');
   const key=id(v);if(!registered(key,kind))fail('所选 JAR 中没有这个 ID：'+key);return key;
  }));
 }
 function coord(value,field){if(!Array.isArray(value)||value.length!==3||!value.every(n=>Number.isInteger(n)&&Math.abs(n)<=16))fail(field+' 必须是三个 −16 到 16 的整数');return value;}
 function anchor(value,field){const keys=Object.keys(value??{}),n=value?.[keys[0]];if(keys.length!==1||!anchors.includes(keys[0])||!Number.isInteger(n)||n< -2032||n>2031)fail(field+' 必须是合法的模板高度锚点（−2032 至 2031）');return keys[0]==='below_top'?h=>h-1-n:()=>n;}
 function readState(raw){
  if(states.has(raw))return states.get(raw);
  const st=catalog.legacy&&(catalog.legacy[maskStateKey(raw)]??raw)||raw;
  let name=st.name.includes(':')?st.name:'minecraft:'+st.name;
  if(catalog.traits&&!Object.hasOwn(catalog.traits,name))name=maskAir.name;
  const row=catalog.traits?.[name];let flags=0;
  if(typeof row==='number')flags=row;
  else if(row){const [base,keys,defaults,overrides,allowed]=row;
   flags=overrides[keys.map((k,i)=>allowed[i].includes(st.props?.[k])?st.props[k]:defaults[i]).join(',')]??base;
  }
  const entry={name,flags};states.set(raw,entry);return entry;
 }
 function walk(o,depth){
  if(depth>12||++nodes>128||!o||Array.isArray(o)||typeof o!=='object')fail('谓词必须为对象，且最多 12 层 / 128 个节点');
  const type=typeof o.type==='string'?o.type.replace(/^minecraft:/,''):'';
  if(blocked.has(type))fail('结构掩码不允许使用 minecraft:'+type);
  if(!Object.hasOwn(predicateFields,type))fail('不支持的方块谓词：'+String(o.type));
  for(const k of Object.keys(o))if(k!=='type'&&!predicateFields[type].includes(k))fail(`${type} 不接受字段 ${k}`);
  if(type==='true')return {cost:1,test:()=>true};
  if(type==='all_of'||type==='any_of'){
   if(!Array.isArray(o.predicates)||o.predicates.length>128)fail(type+' 需要子谓词数组，最多 128 项');
   const terms=o.predicates.map(p=>walk(p,depth+1));return {cost:1+terms.reduce((n,p)=>n+p.cost,0),test:(get,h,x,y,z)=>type==='all_of'?terms.every(t=>t.test(get,h,x,y,z)):terms.some(t=>t.test(get,h,x,y,z))};
  }
  if(type==='not'){const p=walk(o.predicate,depth+1);return {cost:p.cost+1,test:(...args)=>!p.test(...args)};}
  if(type==='height_range'){
   const lo=anchor(o.min_inclusive,'min_inclusive'),hi=anchor(o.max_inclusive,'max_inclusive');return {cost:1,test:(get,h,x,y)=>y>=lo(h)&&y<=hi(h)};
  }
  if(type==='volume_match'){
   const a=coord(o.min,'min'),b=coord(o.max,'max'),p=walk(o.match,depth+1);
   if(a.some((v,i)=>v>b[i]))fail('volume_match 的 min 不能大于 max');
   return {cost:1+a.reduce((n,v,i)=>n*(b[i]-v+1),p.cost),test:(get,h,x,y,z)=>{
    for(let dy=a[1];dy<=b[1];dy++)for(let dz=a[2];dz<=b[2];dz++)for(let dx=a[0];dx<=b[0];dx++)if(!p.test(get,h,x+dx,y+dy,z+dz))return false;return true;
   }};
  }
  const [dx,dy,dz]=o.offset===undefined?[0,0,0]:coord(o.offset,'offset');let check;
  if(type==='matching_blocks'||type==='matching_block_tag'){
   if(type==='matching_block_tag'&&(typeof o.tag!=='string'||o.tag.startsWith('#')))fail('matching_block_tag 的 tag 需要不带 # 的标签 ID');
   const hits=type==='matching_blocks'?set(o.blocks,'block'):tag(o.tag,'block',[],true);check=s=>hits.has(s.name);
  }else{
   if(!catalog.traits)fail(`${type} 需要先加载所选版本的原版方块状态数据`);
   if(type==='matching_fluids'){const hits=set(o.fluids,'fluid');check=s=>hits.has(fluids[s.flags>>8]||fluids[0]);}
   if(type==='solid')check=s=>Boolean(s.flags&1);
   if(type==='replaceable')check=s=>Boolean(s.flags&2);
   if(type==='has_sturdy_face'){const bit=directions.indexOf(o.direction);if(bit<0)fail('请选择有效的支撑面方向');check=s=>Boolean(s.flags&(4<<bit));}
  }
  return {cost:1,test:(get,h,x,y,z)=>check(readState(get(x+dx,y+dy,z+dz)))};
 }
 const result=walk(raw,0);if(result.cost>65536)fail('掩码嵌套区域过大，请缩小 volume_match');return result;
}
export const maskWorkLimit=24_000_000;
