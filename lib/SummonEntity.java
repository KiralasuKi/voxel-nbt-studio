import com.google.gson.Gson;
import com.google.gson.JsonParser;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;
import java.util.regex.Pattern;

// Vanilla's game-test world is created in a temp directory, with no server loop or listener.
class SummonEntity {
 private static final Map<String,String> classes=new HashMap<>();
 private static final Map<String,String> fields=new HashMap<>();
 private static final Map<String,List<Signature>> methods=new HashMap<>();
 private record Signature(String name,String result,String[] parameters) {
  boolean matches(Method method){
   return name.equals(method.getName())&&binaryName(result).equals(method.getReturnType().getTypeName())&&
    Arrays.equals(Arrays.stream(parameters).map(SummonEntity::binaryName).toArray(String[]::new),
                  Arrays.stream(method.getParameterTypes()).map(Class::getTypeName).toArray(String[]::new));
  }
 }
 private static final String MC="net.minecraft.";
 private static final String SERVER="server.MinecraftServer", TEST="gametest.framework.GameTestServer", ENTITY="world.entity.Entity";
 private static final String STORAGE="world.level.storage.LevelStorageSource", PACKS="server.packs.repository.ServerPacksSource";
 private static final String TAG="nbt.CompoundTag", OUTPUT="world.level.storage.TagValueOutput";

 private static final String PROTOCOL="VOXEL-SUMMON\t";
 public static void main(String[] args){
  var protocol=System.out;
  try {
   if(!args[0].equals("-"))readMappings(Path.of(args[0]));
   call("SharedConstants",null,"tryDetectVersion");call("server.Bootstrap",null,"bootStrap");
   if(args[1].equals("--summon"))serve(protocol);
   else if(args[1].equals("--palette"))upgradePalette(Path.of(args[2]),Path.of(args[3]));
   else if(args[1].equals("--structure"))upgradeStructure(Path.of(args[2]),Path.of(args[3]),Integer.parseInt(args[4]),Integer.parseInt(args[5]));
   else if(args[1].equals("--models"))Files.writeString(Path.of(args[2]),new Gson().toJson(bakedEntities(Path.of(args[3]))));
   else writePickShapes(Path.of(args[1]));
   System.exit(0);
  }catch(Throwable e){
   if(e instanceof InvocationTargetException i&&i.getCause()!=null)e=i.getCause();
   e.printStackTrace();System.exit(1);
  }
 }
 private static void serve(java.io.PrintStream protocol)throws Exception{
  var src=call(STORAGE,null,"createDefault",Path.of("worlds"));
  try(var storage=(AutoCloseable)call(STORAGE,src,"createAccess","summon")){
   Object packs;
   try{packs=call(PACKS,null,"createVanillaTrustedRepository");}catch(NoSuchMethodException e){packs=call(PACKS,null,"createPackRepository",storage);}
   var server=testServer(storage,packs);
   initWorld(server);
   call(SERVER,server,"setDifficulty",field("world.Difficulty",null,"NORMAL"),true);
   var level=call(SERVER,server,"overworld");
   var source=call(SERVER,server,"createCommandSourceStack");
   protocol.println(PROTOCOL+"ready");protocol.flush();
   var input=new java.io.BufferedReader(new java.io.InputStreamReader(System.in,java.nio.charset.StandardCharsets.UTF_8));
   for(String line;(line=input.readLine())!=null;){
    var args=line.split("\t",-1);
    if((args.length!=5&&args.length!=6)||!args[0].matches("[0-9]+"))continue;
    try{
     var nbt=summon(source,level,args[1],new String[]{args[2],args[3],args[4]},args.length==6?new String(Base64.getDecoder().decode(args[5]),java.nio.charset.StandardCharsets.UTF_8):null);
     protocol.println(PROTOCOL+args[0]+"\tok\t"+Base64.getEncoder().encodeToString(nbt));
    }catch(ReflectiveOperationException|RuntimeException|java.io.IOException e){
     var cause=e instanceof InvocationTargetException i?i.getCause():e;
     var message=String.valueOf(cause.getMessage()).replaceAll("[\r\n\t]"," ");
     protocol.println(PROTOCOL+args[0]+"\terror\t"+message.substring(0,Math.min(message.length(),500)));
    }
    protocol.flush();
   }
  }
 }
 private static byte[] summon(Object source,Object level,String id,String[] coordinates,String text)throws ReflectiveOperationException,java.io.IOException{
  var identifier=optionalType("resources.Identifier")!=null?call("resources.Identifier",null,"parse",id):
   first("resources.ResourceLocation",null,List.of("parse","tryParse"),id);
  var registry=field("core.registries.BuiltInRegistries",null,"ENTITY_TYPE");
  Optional<?> holder;
  try {
   var result=first("core.Registry",registry,List.of("getHolder","get"),identifier);
   if(!(result instanceof Optional<?> h))throw new NoSuchMethodException("registry holder");
   holder=h;
  }catch(NoSuchMethodException e){
   var key=call("resources.ResourceKey",null,"create",field("core.registries.Registries",null,"ENTITY_TYPE"),identifier);
   holder=(Optional<?>)call("core.Registry",registry,"getHolder",key);
  }
  if(holder.isEmpty())throw new IllegalArgumentException("Unknown entity type");
  var type=call("core.Holder$Reference",holder.get(),"value");
  if(!Boolean.TRUE.equals(call("world.entity.EntityType",type,"canSummon")))throw new IllegalArgumentException("Entity cannot be summoned");
  var pos=type("world.phys.Vec3").getConstructor(double.class,double.class,double.class).newInstance(
   Double.parseDouble(coordinates[0]),Double.parseDouble(coordinates[1]),Double.parseDouble(coordinates[2]));
  var tag=text==null?type(TAG).getConstructor().newInstance():first("nbt.TagParser",null,List.of("parseCompoundFully","parseTag"),text);
  var entity=call("server.commands.SummonCommand",null,"createEntity",source,holder.get(),pos,tag,text==null);
  if(optionalType(OUTPUT)!=null){
   var registries=call("world.level.Level",level,"registryAccess");
   var out=call(OUTPUT,null,"createWithContext",field("util.ProblemReporter",null,"DISCARDING"),registries);
   call(ENTITY,entity,"saveWithoutId",out);tag=call(OUTPUT,out,"buildResult");
  }else call(ENTITY,entity,"saveWithoutId",tag);
  call(TAG,tag,"putString","id",id);
  var bytes=new java.io.ByteArrayOutputStream();
  try(var output=new java.io.DataOutputStream(bytes)){call("nbt.NbtIo",null,"write",tag,output);}
  if(bytes.size()>256*1024)throw new IllegalArgumentException("Entity NBT exceeds 256 KiB");
  return bytes.toByteArray();
 }
 private static Object fixStructure(Object root,int from)throws ReflectiveOperationException {
  var fixer=call("util.datafix.DataFixers",null,"getDataFixer");
  var kind=field("util.datafix.DataFixTypes",null,"STRUCTURE");
  return call("util.datafix.DataFixTypes",kind,"updateToCurrentVersion",fixer,root,from);
 }
 private static void upgradeStructure(Path input,Path output,int from,int to)throws Exception {
  Object root;
  try(var stream=new java.io.DataInputStream(Files.newInputStream(input))){
   root=call("nbt.NbtIo",null,"read",stream,call("nbt.NbtAccounter",null,"create",384L*1024*1024));
  }
  var fixed=fixStructure(root,from);
  call(TAG,fixed,"putInt","DataVersion",to);
  call("nbt.NbtIo",null,"write",fixed,output);
 }
 // Upgrade only a temporary palette for matching against the selected JAR, never the structure file.
 private static void upgradePalette(Path input,Path output)throws Exception {
  var json=JsonParser.parseString(Files.readString(input)).getAsJsonObject();
  var root=type(TAG).getConstructor().newInstance();var list=type("nbt.ListTag").getConstructor().newInstance();
  for(var entry:json.getAsJsonArray("states")){
   var row=entry.getAsJsonObject();var tag=type(TAG).getConstructor().newInstance();var props=type(TAG).getConstructor().newInstance();
   call(TAG,tag,"putString","Name",row.get("name").getAsString());
   for(var prop:row.getAsJsonObject("props").entrySet())call(TAG,props,"putString",prop.getKey(),prop.getValue().getAsString());
   if(!row.getAsJsonObject("props").isEmpty())call(TAG,tag,"put","Properties",props);
   ((List<Object>)list).add(tag);
  }
  call(TAG,root,"put","palette",list);
  var fixed=fixStructure(root,json.get("version").getAsInt());
  var palette=(List<?>)call(TAG,fixed,"get","palette");
  if(palette.size()!=((List<?>)list).size())throw new IllegalStateException("Palette size changed during upgrade");
  var registry=field("core.registries.BuiltInRegistries",null,"BLOCK");
  var out=new ArrayList<Object>();
  for(var tag:palette){
   Object state;
   try{state=call("nbt.NbtUtils",null,"readBlockState",registry,tag);}
   catch(NoSuchMethodException e){state=call("nbt.NbtUtils",null,"readBlockState",call("core.Registry",registry,"asLookup"),tag);}
   var canonical=call("nbt.NbtUtils",null,"writeBlockState",state);
   var id=call(TAG,canonical,"get","id")==null?"Name":"id";
   var props=call(TAG,canonical,"get",id.equals("id")?"properties":"Properties");
   var values=new TreeMap<String,String>();
   if(props!=null)for(var key:(Set<?>)first(TAG,props,List.of("keySet","getAllKeys")))values.put(key.toString(),tagString(props,key.toString()));
   out.add(Map.of("name",tagString(canonical,id),"props",values));
  }
  Files.writeString(output,new Gson().toJson(out));
 }
 private static String tagString(Object tag,String key)throws ReflectiveOperationException {
  Object v=call(TAG,tag,"getString",key);
  return v instanceof Optional<?> o?o.map(Object::toString).orElse(""):v.toString();
 }
 // Older clients use vanilla baked model layers rather than the 26.3 submission collector.
 private static Map<String,Object> bakedEntities(Path file)throws Exception {
  var modelGeom="client.model.geom.";
  var defs=(Map<?,?>)call(modelGeom+"LayerDefinitions",null,"createRoots");
  var layers=new HashMap<String,Object>();
  for(var entry:defs.entrySet()){
   var location=entry.getKey();var layer=first(modelGeom+"ModelLayerLocation",location,List.of("layer","getLayer"));
   if(layer.equals("main")){var id=first(modelGeom+"ModelLayerLocation",location,List.of("model","getModel")).toString();layers.put(id,entry.getValue());}
  }
  var types=new TreeSet<String>();var sizes=new TreeMap<String,Object>();var models=new TreeMap<String,Object>();var unsupported=new TreeMap<String,String>();
  var registry=(Iterable<?>)field("core.registries.BuiltInRegistries",null,"ENTITY_TYPE");
  try(var jar=new java.util.jar.JarFile(file.toFile())){
   var textures=new TreeSet<String>();String prefix="assets/minecraft/textures/entity/";
   jar.stream().map(e->e.getName()).filter(n->n.startsWith(prefix)&&n.endsWith(".png")).forEach(n->textures.add(n.substring(prefix.length(),n.length()-4)));
   var picks=Map.ofEntries(Map.entry("pig","pig/pig"),Map.entry("cow","cow/cow"),Map.entry("chicken","chicken/chicken"),Map.entry("sheep","sheep/sheep"),
    Map.entry("zombie","zombie/zombie"),Map.entry("skeleton","skeleton/skeleton"),Map.entry("creeper","creeper/creeper"),Map.entry("frog","frog/frog_temperate"),
    Map.entry("cat","cat/tabby"),Map.entry("wolf","wolf/wolf"),Map.entry("horse","horse/horse_brown"),Map.entry("villager","villager/villager"),
    Map.entry("slime","slime/slime"),Map.entry("magma_cube","slime/magmacube"),Map.entry("armor_stand","armorstand/wood"),Map.entry("piglin","piglin/piglin"));
   for(var entity:registry){
    var id=call("core.Registry",registry,"getKey",entity).toString();var name=id.substring(id.indexOf(':')+1);
    if((boolean)call("world.entity.EntityType",entity,"canSummon"))types.add(id);
    sizes.put(id,List.of(call("world.entity.EntityType",entity,"getWidth"),call("world.entity.EntityType",entity,"getHeight")));
    try{
     var layer=layers.get(id);if(layer==null)throw new IllegalStateException("no baked layer");
     String texture=picks.getOrDefault(name,name+"/"+name);
     if(!textures.contains(texture))texture=List.of(texture+"_temperate",name,name+"/temperate_"+name,name+"/"+name+"_temperate",name+"/"+name+"_texture")
      .stream().filter(textures::contains).findFirst().orElse(null);
     if(texture==null)throw new IllegalStateException("no matching texture");
     models.put(id,bakeEntityLayer(layer,texture,name.equals("slime")));
    }catch(Exception|LinkageError e){unsupported.put(id,"No offline baked model");}
   }
   var skins=new ArrayList<String>();
   for(String style:List.of("slim","wide"))for(String who:List.of("alex","ari","efe","kai","makena","noor","steve","sunny","zuri"))skins.add("textures/entity/player/"+style+"/"+who+".png");
   for(String who:List.of("player","mannequin"))if(sizes.containsKey("minecraft:"+who))for(String style:List.of("wide","slim")){
    var layer=layers.get("minecraft:player"+(style.equals("slim")?"_slim":""));if(layer==null)continue;
    var id="minecraft:"+who;models.put(id+(style.equals("slim")?"#slim":""),bakeEntityLayer(layer,"player/"+style+"/steve",true));unsupported.remove(id);
   }
   return Map.of("types",types,"sizes",sizes,"models",models,"unsupported",unsupported,"defaultSkins",skins);
  }
 }
 private static List<Object> bakeEntityLayer(Object layer,String texture,boolean translucent)throws Exception {
  var model=call("client.model.geom.builders.LayerDefinition",layer,"bakeRoot");
  var poseOwner="com.mojang.blaze3d.vertex.PoseStack";
  var vertexOwner="com.mojang.blaze3d.vertex.VertexConsumer";
  var pose=type(poseOwner).getConstructor().newInstance();
  call(poseOwner,pose,"scale",-1f,-1f,1f);call(poseOwner,pose,"translate",0f,-1.501f,0f);
  var iface=type(vertexOwner);var verts=new ArrayList<Float>();var q=new float[32];var count=new int[1];
  var add=findMethod(vertexOwner,iface,"addVertex",0f,0f,0f,-1,0f,0f,0,0,0f,0f,0f);
  var sink=Proxy.newProxyInstance(iface.getClassLoader(),new Class[]{iface},(self,m,args)->{
   if(m.equals(add)){
    int k=count[0]++*8,color=(int)args[3];float shade=Math.max(.6f,.75f+.25f*(float)args[9]);
    for(int i=0;i<3;i++)q[k+i]=(float)args[i];
    for(int i=0;i<3;i++)q[k+3+i]=((color>>(16-i*8))&255)/255f*shade;
    q[k+6]=(float)args[4];q[k+7]=(float)args[5];
    if(count[0]==4){for(int i:new int[]{0,1,2,0,2,3})for(int j=0;j<8;j++)verts.add(q[i*8+j]);count[0]=0;}
    return null;
   }
   return m.isDefault()?InvocationHandler.invokeDefault(self,m,args):self;
  });
  call("client.model.geom.ModelPart",model,"render",pose,sink,0,0,-1);
  if(verts.isEmpty())throw new IllegalStateException("Empty baked model");
  return List.of(Map.of("vertices",verts,"texture",texture,"translucent",translucent));
 }
 private static void writePickShapes(Path output)throws Exception {
  var registry=(Iterable<?>)field("core.registries.BuiltInRegistries",null,"BLOCK");
  var world=field("world.level.EmptyBlockGetter",null,"INSTANCE");
  var zero=field("core.BlockPos",null,"ZERO");
  var shapes=new LinkedHashMap<List<Double>,Integer>();
  var rows=new TreeMap<String,Object>();
  var schema=new TreeMap<String,Object>();var traits=new TreeMap<String,Object>();var turns=new TreeMap<String,Object>();
  var rotation=field("world.level.block.Rotation",null,"CLOCKWISE_90");
  var dirs=new ArrayList<Object>();for(var d:List.of("DOWN","UP","NORTH","SOUTH","WEST","EAST"))dirs.add(field("core.Direction",null,d));
  var fluids=field("core.registries.BuiltInRegistries",null,"FLUID");
  var fluidNames=List.of("minecraft:empty","minecraft:water","minecraft:flowing_water","minecraft:lava","minecraft:flowing_lava");
  var base="world.level.block.state.BlockBehaviour$BlockStateBase";
  var holder="world.level.block.state.StateHolder";
  var property="world.level.block.state.properties.Property";
  var blockType="world.level.block.Block";
  var shapeType="world.phys.shapes.VoxelShape";
  var boxNames=List.of("minX","minY","minZ","maxX","maxY","maxZ");
  var sampleBlock=registry.iterator().next();
  var defMethod=findMethod(blockType,sampleBlock,"defaultBlockState");
  var sample=defMethod.invoke(sampleBlock);
  var collision=findMethod(base,sample,"getCollisionShape",world,zero);
  var outline=findMethod(base,sample,"getShape",world,zero);
  var aabbs=findMethod(shapeType,collision.invoke(sample,world,zero),"toAabbs");
  var getKey=findMethod("core.Registry",registry,"getKey",sampleBlock);
  var values=findMethod(holder,sample,"getValue",field("world.level.block.state.properties.BlockStateProperties",null,"WATERLOGGED"));
  var boxFields=boxNames.stream().map(n->{try{return reflectedField("world.phys.AABB",n);}catch(Exception e){throw new IllegalStateException(e);}}).toList();
  var offsetMethod=findMethod(base,sample,"hasOffsetFunction");
  for(var block:registry){
   var key=getKey.invoke(registry,block).toString();
   var def=defMethod.invoke(block);
   var definition=call(blockType,block,"getStateDefinition");
   var props=new TreeMap<String,Object>();
   for(var p:(Collection<?>)call(holder,def,"getProperties"))props.put(call(property,p,"getName").toString(),p);
   var names=List.copyOf(props.keySet());var defaults=new ArrayList<String>();
   for(var name:names){var p=props.get(name);defaults.add(call(property,p,"getName",values.invoke(def,p)).toString());}
   var overrides=new TreeMap<String,Integer>();int initial=-1,defaultFlags=0;
   var flags=new TreeMap<String,Integer>();var allowed=new ArrayList<TreeSet<String>>();
   for(var name:names)allowed.add(new TreeSet<>());
   var rotated=new TreeMap<String,List<String>>();
   for(var state:(Iterable<?>)call("world.level.block.state.StateDefinition",definition,"getPossibleStates")){
    var boxes=new ArrayList<Double>();
    var raw=(List<?>)aabbs.invoke(collision.invoke(state,world,zero));
    boolean useOutline=raw.isEmpty();
    if(useOutline)raw=(List<?>)aabbs.invoke(outline.invoke(state,world,zero));
    var origin=new double[3];
    if(!raw.isEmpty()&&(boolean)offsetMethod.invoke(state)){
     var v=blockOffset(base,state,world,zero);
     double x=(double)field("world.phys.Vec3",v,"x"),y=(double)field("world.phys.Vec3",v,"y"),z=(double)field("world.phys.Vec3",v,"z");
     if(useOutline){
      // Align selection-only plants with the editor's unshifted models, not a random spawn offset.
      origin[0]=x;origin[1]=y;origin[2]=z;
     }else{
      // Four optional offset values precede the sequence of six coordinates per box.
      double horizontal=((Number)call("world.level.block.state.BlockBehaviour",block,"getMaxHorizontalOffset")).doubleValue();
      boxes.add(horizontal);boxes.add(-y);boxes.add(x);boxes.add(z);
     }
    }
    for(var box:raw)for(int i=0;i<boxFields.size();i++)boxes.add(boxFields.get(i).getDouble(box)-origin[i%3]);
    int idx=shapes.computeIfAbsent(boxes,k->shapes.size());
    if(state==def)initial=idx;
    var vals=new ArrayList<String>();var next=new ArrayList<String>();
    var turned=names.isEmpty()?state:call(base,state,"rotate",rotation);
    for(var name:names){var p=props.get(name);var v=call(property,p,"getName",values.invoke(state,p)).toString();
     allowed.get(vals.size()).add(v);vals.add(v);next.add(call(property,p,"getName",values.invoke(turned,p)).toString());}
    var stateKey=String.join(",",vals);
    if(!names.isEmpty()){overrides.put(stateKey,idx);if(!vals.equals(next))rotated.put(stateKey,next);}
    int n=((boolean)call(base,state,"isSolid")?1:0)|((boolean)call(base,state,"canBeReplaced")?2:0);
    for(int i=0;i<dirs.size();i++)if((boolean)call(base,state,"isFaceSturdy",world,zero,dirs.get(i)))n|=4<<i;
    var fluid=call("world.level.material.FluidState",call(base,state,"getFluidState"),"getType");
    n|=Math.max(0,fluidNames.indexOf(call("core.Registry",fluids,"getKey",fluid).toString()))<<8;
    if(state==def)defaultFlags=n;flags.put(stateKey,n);
   }
   final int idx=initial;overrides.values().removeIf(v->v==idx);
   rows.put(key,overrides.isEmpty()?initial:List.of(initial,names,defaults,overrides));
   var spec=new TreeMap<String,Object>();for(int i=0;i<names.size();i++)spec.put(names.get(i),Map.of("default",defaults.get(i),"values",allowed.get(i)));
   schema.put(key,spec);
   final int baseline=defaultFlags;flags.values().removeIf(v->v==baseline);
   traits.put(key,flags.isEmpty()?baseline:List.of(baseline,names,defaults,flags,allowed));
   if(!rotated.isEmpty())turns.put(key,List.of(names,defaults,rotated));
  }
  var tiles=new TreeMap<String,String>();var tileRegistry=(Iterable<?>)field("core.registries.BuiltInRegistries",null,"BLOCK_ENTITY_TYPE");
  for(var tile:tileRegistry){var key=call("core.Registry",tileRegistry,"getKey",tile).toString();
   for(var block:(Set<?>)field("world.level.block.entity.BlockEntityType",tile,"validBlocks"))tiles.put(getKey.invoke(registry,block).toString(),key);}
  Files.writeString(output,new Gson().toJson(Map.of("shapes",shapes.keySet(),"blocks",rows,"schema",schema,"traits",traits,"turns",turns,"tiles",tiles)));
 }
 private static Object blockOffset(String base,Object state,Object world,Object pos)throws ReflectiveOperationException {
  try{return call(base,state,"getOffset",pos);}catch(NoSuchMethodException e){return call(base,state,"getOffset",world,pos);}
 }
 private static void initWorld(Object server)throws Exception {
  var registries=call(SERVER,server,"registries");
  var data=field(SERVER,server,"playerDataStorage");
  // Use the game-test player list without starting the test loop or pregenerating spawn chunks.
  var ctor=Class.forName(type(TEST).getName()+"$1").getDeclaredConstructors()[0];
  var service=optionalType("server.notifications.EmptyNotificationService");
  ctor.setAccessible(true);
  call(SERVER,server,"setPlayerList",ctor.newInstance(server,server,registries,data,service==null?1:service.getConstructor().newInstance()));
  var gizmos=optionalType("gizmos.Gizmos");
  if(gizmos!=null)call("gizmos.Gizmos",null,"withCollector",field("gizmos.GizmoCollector",null,"NOOP"));
  try {call(SERVER,server,"createLevels");}
  catch(NoSuchMethodException e){
   var factory=field(SERVER,server,"progressListenerFactory");
   var progress=call("server.level.progress.ChunkProgressListenerFactory",factory,"create",0);
   call(SERVER,server,"createLevels",progress);
  }
 }
 private static Object testServer(Object storage,Object packs)throws ReflectiveOperationException {
  var thread=Thread.currentThread();
  try{return call(TEST,null,"create",thread,storage,packs,Optional.empty(),false,0);}catch(NoSuchMethodException ignored){}
  try{return call(TEST,null,"create",thread,storage,packs,Optional.empty(),false);}catch(NoSuchMethodException ignored){}
  // Old GameTestServer.create requires a non-empty test collection; none of it is executed.
  var noOp=(java.util.function.Consumer<Object>) ignored->{};
  var function=type("gametest.framework.TestFunction").getConstructor(String.class,String.class,String.class,int.class,long.class,boolean.class,java.util.function.Consumer.class)
   .newInstance("voxel", "voxel", "minecraft:empty",1,0L,true,noOp);
  var batch=type("gametest.framework.GameTestBatch");
  var oldCreate=Arrays.stream(type(TEST).getDeclaredMethods()).filter(m->Modifier.isStatic(m.getModifiers())&&m.getParameterCount()==5&&m.getParameterTypes()[3]==Collection.class).findFirst().orElseThrow();
  var placeholder=oldCreate.getGenericParameterTypes()[3].getTypeName().contains("<"+batch.getName()+">")?
   batch.getConstructor(String.class,Collection.class,java.util.function.Consumer.class,java.util.function.Consumer.class).newInstance("voxel",List.of(function),noOp,noOp):function;
  return call(TEST,null,"create",thread,storage,packs,List.of(placeholder),field("core.BlockPos",null,"ZERO"));
 }
 private static void readMappings(Path file)throws java.io.IOException{
  var method=Pattern.compile("(?:[0-9]+:[0-9]+:)?(\\S+) ([^ ()]+)\\(([^()]*)\\)(?::[0-9:]+)? -> (\\S+)$");
  var f=Pattern.compile("\\S+ (\\S+) -> (\\S+)$");
  String owner="";
  try(var reader=Files.newBufferedReader(file)){
   for(String line;(line=reader.readLine())!=null;){
    if(line.isEmpty()||line.startsWith("#"))continue;
    if(!Character.isWhitespace(line.charAt(0))){
     int cut=line.indexOf(" -> ");if(cut<0||!line.endsWith(":"))continue;
     owner=line.substring(0,cut);classes.put(owner,line.substring(cut+4,line.length()-1));continue;
    }
    var m=method.matcher(line.trim());
    if(m.matches())methods.computeIfAbsent(owner+"#"+m.group(2),k->new ArrayList<>()).add(new Signature(m.group(4),m.group(1),m.group(3).isEmpty()?new String[0]:m.group(3).split(",")));
    else{m=f.matcher(line.trim());if(m.matches())fields.put(owner+"#"+m.group(1),m.group(2));}
   }
  }
 }
 private static String ownerName(String name){return name.startsWith("com.")?name:MC+name;}
 private static Class<?> type(String name)throws ClassNotFoundException{var full=ownerName(name);return Class.forName(classes.getOrDefault(full,full));}
 private static Class<?> optionalType(String name){try{return type(name);}catch(ClassNotFoundException e){return null;}}
 private static String binaryName(String name){int i=name.indexOf('[');return i<0?classes.getOrDefault(name,name):classes.getOrDefault(name.substring(0,i),name.substring(0,i))+name.substring(i);}
 private static Field reflectedField(String owner,String name)throws ReflectiveOperationException{
  var f=type(owner).getDeclaredField(fields.getOrDefault(MC+owner+"#"+name,name));f.setAccessible(true);return f;
 }
 private static Object field(String owner,Object target,String name)throws ReflectiveOperationException{return reflectedField(owner,name).get(target);}
 private static Object first(String owner,Object target,List<String> names,Object... args)throws ReflectiveOperationException{
  for(String name:names)try{return call(owner,target,name,args);}catch(NoSuchMethodException ignored){}
  throw new NoSuchMethodException(owner+"."+names);
 }
 private static Object call(String owner,Object target,String name,Object... args)throws ReflectiveOperationException{return findMethod(owner,target,name,args).invoke(target,args);}
 private static Method findMethod(String owner,Object target,String name,Object... args)throws ReflectiveOperationException{
  var signatures=methods.get(ownerName(owner)+"#"+name);
  for(var m:type(owner).getDeclaredMethods()){
   if(m.getParameterCount()!=args.length||Modifier.isStatic(m.getModifiers())!=(target==null))continue;
   if(signatures==null?!name.equals(m.getName()):signatures.stream().noneMatch(s->s.matches(m)))continue;
   var types=m.getParameterTypes();boolean matches=true;
   for(int i=0;i<args.length;i++){
    var t=types[i];if(t==boolean.class)t=Boolean.class;if(t==int.class)t=Integer.class;if(t==long.class)t=Long.class;if(t==float.class)t=Float.class;if(t==double.class)t=Double.class;
    if(!t.isInstance(args[i])){matches=false;break;}
   }
   if(matches){m.setAccessible(true);return m;}
  }
  throw new NoSuchMethodException(owner+"."+name);
 }
}
