const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs'),path=require('path');const c=require('../ResolveHDRtoSDR/core');
const tools={ffmpeg:process.env.HDR_FFMPEG||'',ffprobe:process.env.HDR_FFPROBE||''};
const base={index:0,codec_type:'video',codec_name:'hevc',color_primaries:'bt2020',color_transfer:'smpte2084',color_space:'bt2020nc',duration:'1'};
function data(changes={},side=[]){return {streams:[{...base,...changes,side_data_list:side}],frames:[]};}
test('PQ, HLG, SDR, incomplete tags and interlaced classification',()=>{
  assert.equal(c.classify(data()).eligible,true);assert.equal(c.classify(data({color_transfer:'arib-std-b67'})).format,'HLG');
  for(const change of [{color_transfer:'bt709'},{color_primaries:'unknown'},{color_space:'unknown'},{field_order:'tt'},{duration:'0'}])assert.equal(c.classify(data(change)).eligible,false);
});
test('Dolby profiles and Vivid fallback are explicit',()=>{
  const dv=p=>[{side_data_type:'DOVI configuration record',dv_profile:p,dv_bl_signal_compatibility_id:4}];
  assert.equal(c.classify(data({color_transfer:'arib-std-b67'},dv(8))).eligible,true);
  assert.equal(c.classify(data({},dv(8))).eligible,false);
  assert.equal(c.classify(data({},dv(5))).eligible,false);
  assert.equal(c.classify(data({},[...dv(5),{side_data_type:'Dolby Vision RPU Data'}])).eligible,true);
  assert.equal(c.classify(data({},dv(7))).eligible,false);
  const vivid=c.classify(data({},[{side_data_type:'HDR Dynamic Metadata CUVA 005.1 2021 (HDR Vivid)'}]));assert.equal(vivid.vivid,true);assert.match(vivid.reason,/基础层/);
});
test('safe command arguments preserve literal filenames and clean frame metadata',()=>{
  const args=c.buildArgs('中文 & $(bad).mov','out.mp4',c.classify(data()),'hevc');assert.equal(args[args.indexOf('-i')+1],'中文 & $(bad).mov');assert.ok(args.includes('-n'));assert.match(args[args.indexOf('-vf')+1],/sidedata=mode=delete/);
});
test('AAC plus unsupported APAC preserves AAC only; unsupported-only audio blocks conversion',()=>{
  const d=data();d.streams.push({index:1,codec_type:'audio',codec_name:'aac',channels:2},{index:2,codec_type:'audio',codec_tag_string:'apac',channels:4});
  const info=c.classify(d);assert.equal(info.eligible,true);assert.deepEqual(info.audioIndices,[1]);assert.match(info.audioNote,/apac/);
  const args=c.buildArgs('input.mov','output.mp4',info,'hevc');const mappings=args.flatMap((v,i)=>v==='-map'?[args[i+1]]:[]);assert.deepEqual(mappings,['0:0','0:1']);
  d.streams.splice(1,1);assert.equal(c.classify(d).eligible,false);
});
test('GPU mode uses CUDA decode, main10 NVENC and P010 pixels',()=>{const args=c.buildArgs('input.mov','out.mp4',c.classify(data()),'hevc_gpu');assert.equal(args[args.indexOf('-hwaccel')+1],'cuda');assert.ok(args.indexOf('-hwaccel')<args.indexOf('-i'));assert.equal(args[args.indexOf('-c:v')+1],'hevc_nvenc');assert.equal(args[args.indexOf('-pix_fmt')+1],'p010le');assert.equal(args.includes('libx265'),false);});
test('validation rejects HDR tags, residual metadata, truncated files',()=>{
  const good={streams:[{...base,color_primaries:'bt709',color_transfer:'bt709',color_space:'bt709',color_range:'tv'}]};c.validate(good,1);
  assert.throws(()=>c.validate(data(),1));assert.throws(()=>c.validate({...good,frames:[{side_data_list:[{side_data_type:'Mastering display metadata'}]}]},1));assert.throws(()=>c.validate(good,10));
});
test('already cancelled processes never launch',async()=>{const controller=new AbortController();controller.abort();await assert.rejects(c.run('missing',[],{signal:controller.signal}),{name:'Cancelled'});});
test('live cancellation cleans partial output and preserves original',{skip:!fs.existsSync(tools.ffmpeg),timeout:30000},async()=>{
  const root=path.join(__dirname,'artifacts','cancel');fs.mkdirSync(root,{recursive:true});const source=path.join(root,'source.mkv');
  await c.run(tools.ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=256x144:rate=30:duration=60','-c:v','ffv1',source]);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),150);
  try{await assert.rejects(c.convert(tools,source,{streamIndex:0,duration:60},{root,signal:controller.signal}),{name:'Cancelled'});}finally{clearTimeout(timer);}
  assert.equal(fs.existsSync(source),true);assert.equal(fs.readdirSync(root).some(name=>name.includes('.partial')),false);
});
test('real FFmpeg HLG and PQ conversion, both encoders, audio and Unicode paths',{skip:!fs.existsSync(tools.ffmpeg),timeout:120000},async()=>{
  const root=path.join(__dirname,'artifacts');fs.mkdirSync(root,{recursive:true});await c.checkTools(tools);
  for(const [trc,mode] of [['arib-std-b67','hevc'],['smpte2084','dnxhr']]){
    const source=path.join(root,`测试素材 & ${trc}.mov`);
    await c.run(tools.ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=256x144:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-vf',`format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=${trc}:colorspace=bt2020nc`,'-c:v','libx265','-preset','ultrafast','-x265-params','log-level=error','-tag:v','hvc1','-c:a','pcm_s16le','-color_primaries','bt2020','-color_trc',trc,'-colorspace','bt2020nc',source]);
    const info=c.classify(await c.probe(tools.ffprobe,source));assert.equal(info.eligible,true);
    let progress=0;const output=await c.convert(tools,source,info,{mode,onProgress:p=>{progress=p;}});assert.equal(progress,100);assert.match(output,/_转换SDR/);
    const result=await c.probe(tools.ffprobe,output);c.validate(result,1);assert.ok(result.streams.some(s=>s.codec_type==='audio'));assert.equal(result.streams.find(s=>s.codec_type==='video').codec_name,mode==='hevc'?'hevc':'dnxhd');
    assert.ok(await c.findExisting(tools,source,info));assert.equal(await c.findExisting(tools,source,{...info,duration:20}),'');
  }
});
