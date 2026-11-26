'use strict';
const assert=require('node:assert/strict');
const {readdir}=require('node:fs/promises');
const path=require('node:path');
const {jarMaskData}=require('../lib/assets');
const {collisionShapes,summonEntity,stopSummon}=require('../lib/native-summon');
const {entityModels}=require('../lib/mask-java');
const {Structure,create}=require('../lib/nbt');
const {rotateState}=require('../lib/rotation');

async function check(jar,compileMask){
 const [game,entities,mask]=await Promise.all([collisionShapes(jar),entityModels(jar),jarMaskData(jar)]);
 assert.equal(game.dataVersion,mask.dataVersion);
 assert.ok(game.blocks['minecraft:stone']!==undefined&&game.schema['minecraft:oak_log'].axis.values.includes('z'));
 assert.equal(game.tiles['minecraft:chest'],'minecraft:chest');
 assert.equal(rotateState({name:'minecraft:oak_log',props:{axis:'x'}},1,1,game).state.props.axis,'z');
 const stone={name:'minecraft:stone',props:{}};
 assert.equal(compileMask({type:'solid'},{...mask,traits:game.traits}).test(()=>stone,2,0,0,0),true);
 assert.ok(entities.models['minecraft:pig']?.[0].vertices.length);
 const spawn=await summonEntity(jar,'minecraft:pig',[1,1,1],'{NoAI:1b}');
 assert.equal(spawn.dv,game.dataVersion);
 let doc=await Structure.open(create([4,4,4],game.dataVersion));doc.gameCatalog=game;
 doc.edit({tool:'place',points:[[0,0,0]],state:{name:'minecraft:chest'}});
 doc=await Structure.open(doc.layout({kind:'entity',action:'add',id:'minecraft:pig',pos:[1,1,1],summoned:spawn.nbt,palette:0}).raw);
 doc=await Structure.open(await doc.serialize());
 assert.equal(doc.dv,game.dataVersion);
 assert.equal(doc.paletteView()[0].name,'minecraft:chest');
 assert.equal(doc.blockData(0).id,'minecraft:chest');
 assert.match(doc.entityDetails(0).text,/"NoAI":1b/);
 console.log(`${game.version} (DV ${game.dataVersion}): block catalog, rotation, mask, ${Object.keys(entities.models).length} entity models, summon and NBT round trip OK`);
}
async function main(){
 const dir=process.argv[2];assert.ok(dir,'Usage: node scripts/test-java-releases.cjs <directory of client JARs>');
 const selected=new Set(process.argv.slice(3).map(version=>version+'.jar'));
 const paths=(await readdir(dir)).filter(name=>(!selected.size||selected.has(name))&&/^(?:1\.21(?:\.\d+)?|26\.\d+(?:\.\d+)?)\.jar$/.test(name)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
 assert.ok(paths.length,'No release JARs found');
 const {compileMask}=await import('../media/mask.js');
 let failures=0;
 for(const name of paths){
  try{await check(path.resolve(dir,name),compileMask);}catch(e){failures++;console.error(name,e.message);}finally{await stopSummon();}
 }
 console.log(`${paths.length-failures}/${paths.length} releases passed`);
 if(failures)process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
