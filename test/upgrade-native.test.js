'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const zlib=require('node:zlib');
const {Document}=require('../lib/document'),{Structure}=require('../lib/nbt');
const {isCachedClient,upgradeVersions}=require('../lib/mojang');
const {Reader,named,utf}=require('../lib/nbt-codec'),{parse}=require('../lib/snbt');
const jars=process.env.VOXEL_RELEASE_JARS;
test('offline official cache accepts every supported JAR and rejects wrong or missing files',{skip:!jars},async()=>{
 for(const {label,dv} of upgradeVersions(0))assert.equal(await isCachedClient(dv,path.join(jars,label+'.jar')),true,label);
 assert.equal(await isCachedClient(3955,path.join(jars,'26.3.jar')),false);
 assert.equal(await isCachedClient(3955,path.join(jars,'missing.jar')),false);
});
const make=text=>named(10,'Fixture',parse(text,utf).data);
const fixture=make(`{DataVersion:3955,size:[2,1,1],
  palettes:[[{Name:"minecraft:chest",Properties:{facing:"north"}}],[{Name:"minecraft:trapped_chest",Properties:{facing:"north"}}]],
  blocks:[{pos:[0,0,0],state:0,nbt:{id:"minecraft:chest",CustomName:'{"text":"Chest"}',Items:[{Slot:0b,id:"minecraft:paper",count:1,components:{"minecraft:custom_name":'{"text":"Paper"}'}}]}}],
  entities:[{pos:[1.5d,0d,0.5d],blockPos:[1,0,0],nbt:{id:"minecraft:armor_stand",CustomName:'{"text":"Entity"}',ArmorItems:[{},{},{},{id:"minecraft:diamond_helmet",count:1}]}}],extra:{key:123L}}`);

async function withDoc(input,fn){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'voxel_upgrade_test_'));
  const file=path.join(dir,'sample.nbt');await fs.writeFile(file,input);
  const doc=new Document({fsPath:file},file,null);
  try{await doc.ready;await fn(doc,file,dir);}
  finally{
    doc.dispose();const target=path.resolve(dir);
    if(path.dirname(target)===path.resolve(os.tmpdir())&&path.basename(target).startsWith('voxel_upgrade_test_'))await fs.rm(target,{recursive:true,force:true,maxRetries:3});
  }
}

for(const [release,target] of [['1.21.5',4325],['26.3',5023]])test(`Minecraft ${release} upgrades real NBT internals and preserves compression`,{skip:!jars},async()=>{
  const modern=release==='26.3',input=modern?zlib.gzipSync(fixture):zlib.deflateSync(fixture);
  await withDoc(input,async(doc,file,dir)=>{
    const jar=path.join(jars,release+'.jar'),copy=modern?path.join(dir,`sample_${release}.nbt`):undefined;
    assert.equal(await doc.call('dataVersion'),3955);
    if(modern)await doc.call('edit',{tool:'place',points:[[1,0,0]],state:{name:'minecraft:stone'}});
    assert.equal(await doc.upgrade(jar,target,copy,()=>true),true);
    const result=await Structure.open(await fs.readFile(copy??file));
    assert.equal(await doc.call('dataVersion'),modern?3955:target);
    if(modern){assert.deepEqual(await fs.readFile(file),input);assert.equal(result.state((result.at(result.cell([1,0,0]))>>1)-1).name,'minecraft:stone');}
    else{const saved=await doc.call('save');assert.equal(doc.disk,saved.hash);assert.deepEqual(await fs.readFile(file),Buffer.from(saved.data));}
    assert.equal(result.zip,modern?'gzip':'zlib');assert.equal(result.dv,target);
    assert.deepEqual(result.palettes.map(p=>p.modern),[modern,modern]);
    assert.deepEqual(result.palettes.map(p=>p.states[0].name),['minecraft:chest','minecraft:trapped_chest']);
    const root=new Reader(result.b);assert.equal(root.byte(),10);assert.equal(root.str(),'Fixture');
    const text=root.snbt(10);
    assert.match(text,/"CustomName":\{"text":"Chest"\}/);
    assert.match(text,/"minecraft:custom_name":\{"text":"Paper"\}/);
    assert.match(text,/"CustomName":\{"text":"Entity"\}/);
    assert.match(text,/"equipment":\{"head":\{[^{}]*"id":"minecraft:diamond_helmet"/);
    assert.match(text,/"extra":\{"key":123L\}/);
  });
});

test('Minecraft 1.21 renames a legacy block in raw NBT without overwriting a conflicting destination or source', {skip:!jars},async()=>{
  const old=make('{DataVersion:2567,size:[1,1,1],palette:[{Name:"minecraft:grass_path"}],blocks:[{pos:[0,0,0],state:0}],entities:[]}');
  await withDoc(old,async(doc,file,dir)=>{
    const jar=path.join(jars,'1.21.jar'),copy=path.join(dir,'sample_1.21.nbt');
    await assert.rejects(doc.upgrade(path.join(dir,'missing.jar'),3953,copy,()=>true),/ENOENT/);
    assert.deepEqual(await fs.readdir(dir),['sample.nbt']);
    assert.equal(await doc.upgrade(jar,3953,copy,()=>false),false);
    assert.deepEqual(await fs.readdir(dir),['sample.nbt']);
    assert.equal(await doc.upgrade(jar,3953,copy,()=>true),true);
    const bytes=await fs.readFile(copy),result=await Structure.open(bytes);
    assert.equal(result.zip,'raw');assert.equal(result.dv,3953);
    assert.equal(result.palettes[0].states[0].name,'minecraft:dirt_path');
    await assert.rejects(doc.upgrade(jar,3953,copy,()=>true),{code:'EEXIST'});
    assert.deepEqual(await fs.readFile(copy),bytes);assert.deepEqual(await fs.readFile(file),old);
    await fs.writeFile(file,Buffer.from('external edit'));
    await assert.rejects(doc.upgrade(jar,3953,null,()=>true),/外部修改/);
    assert.equal(await fs.readFile(file,'utf8'),'external edit');assert.equal(await doc.call('dataVersion'),2567);
    assert.deepEqual((await fs.readdir(dir)).sort(),['sample.nbt','sample_1.21.nbt']);
  });
});
