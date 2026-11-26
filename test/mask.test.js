const {test}=require('node:test'),assert=require('node:assert/strict');
const {Worker}=require('node:worker_threads'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Structure,create}=require('../lib/nbt'),traits=require('../media/mask-states.json');
const catalog={traits,tags:{block:{'minecraft:logs':['#minecraft:oak_logs',{id:'#minecraft:optional',required:false}],'minecraft:oak_logs':['minecraft:oak_log']},fluid:{'minecraft:water':['minecraft:water','minecraft:flowing_water']}}};
const pred=(type,fields={})=>({type:'minecraft:'+type,...fields});

test('compile masks: selected JAR tag recursion, predicates, local height and native state flags',async()=>{
 const {compileMask,maskAir}=await import('../media/mask.js');
 const states=new Map([['0,0,0',{name:'minecraft:oak_log',props:{}}],['0,1,0',{name:'minecraft:oak_slab',props:{type:'top',waterlogged:'true'}}],['1,0,0',{name:'minecraft:stone',props:{}}]]);
 const get=(...p)=>states.get(p.join(','))||maskAir;
 const mask=compileMask(pred('all_of',{predicates:[pred('matching_blocks',{blocks:'#minecraft:logs'}),pred('matching_fluids',{fluids:'#minecraft:water',offset:[0,1,0]}),pred('height_range',{min_inclusive:{absolute:0},max_inclusive:{below_top:2}})]}),catalog);
 assert.equal(mask.test(get,3,0,0,0),true);assert.equal(mask.test(get,3,1,0,0),false);
 assert.equal(compileMask(pred('matching_block_tag',{tag:'minecraft:logs'}),catalog).test(get,3,0,0,0),true);
 const volume=pred('volume_match',{min:[0,0,0],max:[1,0,0],match:pred('has_sturdy_face',{direction:'up'})});
 assert.equal(compileMask(volume,catalog).test(get,3,0,0,0),true);assert.equal(compileMask(volume,catalog).test(get,3,0,1,0),false);
 assert.equal(compileMask(pred('replaceable'),catalog).test(get,3,2,0,0),true);
 assert.equal(compileMask(pred('solid'),catalog).test(get,3,1,0,0),true);
 const height=compileMask(pred('height_range',{min_inclusive:{absolute:1},max_inclusive:{below_top:0}}),catalog);
 assert.equal(height.test(get,3,0,0,0),false);assert.equal(height.test(get,3,0,1,0),true);assert.equal(height.test(get,3,0,2,0),true);assert.equal(height.test(get,3,0,3,0),false);

 assert.throws(()=>compileMask(pred('solid'),{tags:catalog.tags}),/原版方块状态数据/);
 assert.throws(()=>compileMask(pred('true'),null),/JAR/);
 assert.throws(()=>compileMask(pred('matching_block_tag',{tag:'#minecraft:logs'}),catalog),/不带 #/);
 assert.equal(compileMask(pred('matching_block_tag',{tag:'minecraft:missing'}),catalog).test(get,3,0,0,0),false);
 assert.throws(()=>compileMask(pred('matching_blocks',{blocks:'#minecraft:missing'}),catalog),/找不到标签/);
 for(const type of ['unobstructed','matching_biomes','would_survive','inside_world_bounds'])assert.throws(()=>compileMask(pred('not',{predicate:pred(type)}),catalog),/不允许使用/);
});

test('worker rejects masks without a JAR catalog and masks only original target voxels',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_mask_test_')),file=path.join(root,'fixture.nbt'),d=await Structure.open(create([4,3,3]));
 d.edit({tool:'place',points:[[0,0,0],[1,0,0]],state:{name:'minecraft:oak_log',props:{}}});
 d.edit({tool:'place',points:[[2,0,0]],state:{name:'minecraft:stone',props:{}}});await fs.writeFile(file,await d.serialize());
 const worker=new Worker(path.join(__dirname,'../lib/worker.js'));let id=0;
 function call(method,...args){return new Promise((yes,no)=>{worker.once('message',m=>m.error?no(new Error(m.error)):yes(m.result));worker.postMessage({id:++id,method,args});});}
 try{
  await call('load',file,null);
  const q={tool:'fill',state:{name:'minecraft:amethyst_block',props:{}},box:[[0,0,0],[2,0,0]],mask:pred('matching_blocks',{blocks:'#minecraft:logs',offset:[-1,0,0]})};
  await assert.rejects(call('edit',q),/JAR/);await call('maskCatalog',catalog);
  assert.equal((await call('edit',q)).changes.length,6); // x=2 still sees the original log at x=1.
  const result=await Structure.open((await call('save')).data);
  assert.equal(result.snapshot().states[(result.at(result.cell([0,0,0]))>>1)-1].name,'minecraft:oak_log');
  assert.equal(result.snapshot().states[(result.at(result.cell([2,0,0]))>>1)-1].name,'minecraft:amethyst_block');
  await assert.rejects(call('edit',{...q,tool:'erase'}),/涂刷、放置和框填/);
  const place={tool:'place',state:{name:'minecraft:bricks',props:{}},points:[[0,1,0],[1,1,0],[0,0,0]]};
  assert.equal((await call('edit',{...place,mask:pred('matching_blocks',{blocks:'#minecraft:logs'})})).changes.length,0); // empty destinations aren't logs
  const placed=await call('edit',{...place,mask:pred('matching_blocks',{blocks:'#minecraft:logs',offset:[0,-1,0]})});
  assert.equal(placed.changes.length,3);assert.equal(placed.changes[0],d.cell([0,1,0]));
  const edge={...place,points:[[-1,0,0],[0,1,1]]};
  const blocked=await call('edit',{...edge,mask:pred('matching_blocks',{blocks:'minecraft:bricks',offset:[0,0,-1]})});
  assert.equal(blocked.token,undefined);assert.equal(blocked.changes.length,3);assert.deepEqual((await call('view',0)).size,[4,3,3]);
  const expanded=await call('edit',{...edge,mask:pred('matching_blocks',{blocks:'#minecraft:logs',offset:[1,0,0]})});
  assert.deepEqual(expanded.size,[5,3,3]);assert.deepEqual(expanded.offset,[1,0,0]);
  await call('restoreLayout',expanded.token,false);
  const painted=await call('edit',{tool:'paint',mask:pred('matching_block_tag',{tag:'minecraft:logs'}),points:[[0,0,0],[1,0,0]],state:{name:'minecraft:dirt',props:{}}});assert.equal(painted.changes.length,3);
 }finally{await worker.terminate();const checked=path.resolve(root);if(path.dirname(checked)===path.resolve(os.tmpdir())&&path.basename(checked).startsWith('voxel_mask_test_'))await fs.rm(checked,{recursive:true,force:true});}
});

test('legacy mask uses the active palette and never rewrites the original NBT', {skip:!process.env.VOXEL_MASK_JAR},async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_mask_test_')),file=path.join(root,'old.nbt');
 const cat=(...chunks)=>Buffer.concat(chunks.map(v=>typeof v==='number'?Buffer.from([v]):v));
 const int=v=>{const b=Buffer.alloc(4);b.writeInt32BE(v);return b;};
 const str=s=>cat(0,Buffer.byteLength(s),Buffer.from(s));
 const field=(t,n,v)=>cat(t,str(n),v),list=(t,...items)=>cat(t,int(items.length),...items);
 const state=name=>cat(field(8,'Name',str(name)),0),pos=(x,y,z)=>list(3,int(x),int(y),int(z));
 const old=cat(10,str(''),field(3,'DataVersion',int(4189)),field(9,'size',pos(1,1,1)),
  field(9,'palettes',list(9,list(10,state('minecraft:chain')),list(10,state('minecraft:air')))),
  field(9,'blocks',list(10,cat(field(9,'pos',pos(0,0,0)),field(3,'state',int(0)),0))),0);
 await fs.writeFile(file,old);
 const worker=new Worker(path.join(__dirname,'../lib/worker.js'));let id=0;
 const call=(method,...args)=>new Promise((yes,no)=>{worker.once('message',m=>m.error?no(new Error(m.error)):yes(m.result));worker.postMessage({id:++id,method,args});});
 try{
  const jar=process.env.VOXEL_MASK_JAR;
  await call('load',file,null);
  const legacy=await call('maskCatalog',{...await require('../lib/assets').jarMaskData(jar),traits},jar);
  const {maskStateKey}=await import('../media/mask.js');
  assert.equal(legacy[maskStateKey({name:'minecraft:chain',props:{}})].name,'minecraft:iron_chain');
  assert.deepEqual(Buffer.from((await call('save')).data),old);
  const edit={tool:'fill',box:[[0,0,0],[0,0,0]],state:{name:'minecraft:dirt',props:{}},mask:pred('solid')};
  assert.equal((await call('edit',{...edit,palette:1})).changes.length,0);
  const patch=await call('edit',{...edit,palette:0});assert.equal(patch.changes.length,3);
  await call('apply',patch.changes,false,patch.tiles,patch.added);
  assert.deepEqual(Buffer.from((await call('save')).data),old);
 }finally{await worker.terminate();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('voxel_mask_test_'))await fs.rm(root,{recursive:true,force:true});}
});
