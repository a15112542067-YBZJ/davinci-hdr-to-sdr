'use strict';
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');

class Cancelled extends Error { constructor(){super('已取消'); this.name='Cancelled';} }
function run(exe,args,{signal,onLine,timeout=0}={}) {
  return new Promise((resolve,reject)=>{
    if(signal?.aborted) return reject(new Cancelled());
    const child=spawn(exe,args,{windowsHide:true,shell:false});
    let out='',err='',pending='',timer;
    const abort=()=>child.kill();
    signal?.addEventListener('abort',abort,{once:true});
    if(timeout) timer=setTimeout(()=>child.kill(),timeout);
    child.stdout.on('data',data=>{const s=data.toString();if(!onLine)out+=s;if(onLine){pending+=s;const lines=pending.split(/\r?\n/);pending=lines.pop();lines.forEach(onLine);} });
    child.stderr.on('data',data=>{err=(err+data.toString()).slice(-16000);});
    child.on('error',reject);
    child.on('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(signal?.aborted)reject(new Cancelled());else if(code!==0)reject(new Error(err||`进程退出 ${code}`));else resolve(out);});
  });
}
async function probe(exe,file,signal,frames=true){
  const args=['-v','error','-show_streams','-show_format'];
  if(frames)args.push('-read_intervals','%+#120','-show_frames');
  args.push('-of','json',file);
  return JSON.parse(await run(exe,args,{signal,timeout:120000}));
}
function classify(data,audioDecoders=['aac','alac','mp3','opus','vorbis','flac','ac3','eac3','pcm_s16le','pcm_s24le','pcm_s32le','pcm_f32le','pcm_s16be','pcm_s24be']){
  const stream=(data.streams||[]).find(s=>s.codec_type==='video'&&!s.disposition?.attached_pic);
  if(!stream)return {eligible:false,format:'无视频轨道',reason:'跳过音频、时间线或不支持的素材'};
  const frames=(data.frames||[]).filter(f=>f.media_type==='video');
  const sides=[...(stream.side_data_list||[]),...frames.flatMap(f=>f.side_data_list||[])];
  const dv=sides.find(s=>/DOVI configuration/i.test(s.side_data_type||''));
  const dvData=sides.some(s=>/Dolby Vision|DOVI RPU|DOVI Metadata/i.test(s.side_data_type||''));
  const vivid=sides.some(s=>/vivid/i.test(s.side_data_type||''));
  const plus=sides.some(s=>/2094.40|HDR10\+/i.test(s.side_data_type||''));
  const trc=stream.color_transfer||frames[0]?.color_transfer||'unknown';
  const prim=stream.color_primaries||frames[0]?.color_primaries||'unknown';
  const matrix=stream.color_space||frames[0]?.color_space||'unknown';
  const range=stream.color_range||frames[0]?.color_range||'unknown';
  const duration=Number(stream.duration||data.format?.duration||0);
  let format=trc==='arib-std-b67'?'HLG':trc==='smpte2084'?'PQ / HDR10':'SDR / 未识别';
  let reason='',eligible=['arib-std-b67','smpte2084'].includes(trc)&&prim==='bt2020'&&['bt2020nc','bt2020c'].includes(matrix);
  if(dv){format=`Dolby Vision P${dv.dv_profile} · 兼容ID ${dv.dv_bl_signal_compatibility_id}`;
    const compatible=Number(dv.dv_bl_signal_compatibility_id);
    const matchingBase=(compatible===1&&trc==='smpte2084')||(compatible===4&&trc==='arib-std-b67');
    eligible=(Number(dv.dv_profile)===8&&matchingBase&&eligible)||(Number(dv.dv_profile)===5&&dvData);
    reason=eligible?(dvData?'检测到 Dolby Vision 帧元数据，交由 libplacebo 处理':'未检测到 RPU：使用兼容基础层＋动态亮度映射'):'暂不支持此杜比视界配置、P5 缺少帧元数据或色彩标签冲突';
  } else if(vivid){format=`HDR Vivid · ${trc==='arib-std-b67'?'HLG':trc==='smpte2084'?'PQ':trc}`;reason='基础层转换；本版不应用 Vivid 动态元数据';}
  else if(plus){format='HDR10+ / PQ';reason='使用解码器提供的动态亮度数据';}
  if(!reason)reason=eligible?'可转换：动态亮度映射＋感知色域压缩':trc==='bt709'?'已是 SDR，跳过':'色彩标签不完整、Log 或不支持的编码；不自动猜测';
  if(!duration||duration<=0){eligible=false;reason='无法确定时长，暂不支持';}
  if(stream.field_order&&!['progressive','unknown'].includes(stream.field_order)){eligible=false;reason='暂不支持隔行素材';}
  const audio=(data.streams||[]).filter(s=>s.codec_type==='audio');
  const supported=audio.filter(s=>audioDecoders.includes(s.codec_name));
  const skipped=audio.filter(s=>!audioDecoders.includes(s.codec_name)).map(s=>({index:s.index,codec:s.codec_name||s.codec_tag_string||'unknown'}));
  const audioIndices=supported.map(s=>s.index);
  const audioNote=audio.length?`保留 ${supported.length} 条可解码音轨${skipped.length?'；跳过不支持的附加音轨：'+skipped.map(s=>s.codec).join('、'):''}`:'原素材无音轨';
  if(audio.length&&!supported.length){eligible=false;reason='没有可解码音轨，暂不转换，避免丢失全部声音';}
  return {eligible,format,reason,audioIndices,skippedAudio:skipped,audioNote,trc,prim,matrix,range,duration,codec:stream.codec_name,pixFmt:stream.pix_fmt,streamIndex:stream.index,dv:dv||null,dvData,vivid,plus};
}
function outputPath(source,root,mode){
  const dir=root?path.resolve(root):path.join(path.dirname(source),'转换SDR');fs.mkdirSync(dir,{recursive:true});
  const ext=mode==='dnxhr'?'.mov':'.mp4';const base=path.parse(source).name+'_转换SDR';
  let file=path.join(dir,base+ext),n=2;while(fs.existsSync(file)||fs.existsSync(file+'.partial'+ext))file=path.join(dir,base+'_'+n+++ext);
  return file;
}
function buildArgs(source,temp,info,mode){
  const gpu=mode==='hevc_gpu';
  const filter='libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=auto:gamut_mode=perceptual:peak_detect=1:apply_dolbyvision=1:format='+(gpu?'p010le':'yuv420p10le')+',sidedata=mode=delete';
  const args=['-hide_banner','-nostdin','-n','-loglevel','warning'];
  if(gpu)args.push('-hwaccel','cuda');
  args.push('-i',source,'-map',`0:${info.streamIndex}`);
  for(const index of info.audioIndices||[])args.push('-map',`0:${index}`);
  args.push('-map_metadata','-1','-map_chapters','-1','-vf',filter);
  if(mode==='dnxhr')args.push('-c:v','dnxhd','-profile:v','dnxhr_hqx','-pix_fmt','yuv422p10le','-c:a','pcm_s24le');
  else if(gpu)args.push('-c:v','hevc_nvenc','-profile:v','main10','-preset','p5','-tune','hq','-rc','vbr','-cq','18','-b:v','0','-pix_fmt','p010le','-tag:v','hvc1','-c:a','aac','-b:a','320k');
  else args.push('-c:v','libx265','-preset','medium','-crf','18','-pix_fmt','yuv420p10le','-tag:v','hvc1','-c:a','aac','-b:a','320k');
  args.push('-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-color_range','tv','-fps_mode','passthrough','-movflags','+faststart','-progress','pipe:1','-nostats',temp);
  return args;
}
async function checkEncoder(tools,mode,signal){
  if(mode!=='hevc_gpu')return;
  try{await run(tools.ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=256x144:duration=0.1','-vf','format=p010le','-c:v','hevc_nvenc','-profile:v','main10','-f','null','-'],{signal,timeout:30000});}
  catch(e){if(e.name==='Cancelled')throw e;throw Error('NVIDIA GPU 编码不可用，请检查显卡驱动或选择 CPU 编码。'+e.message);}
}
async function findExisting(tools,source,info,{root='',signal}={}){
  const dir=root?path.resolve(root):path.join(path.dirname(source),'转换SDR');
  if(!fs.existsSync(dir))return '';
  const base=path.parse(source).name+'_转换SDR';
  const files=fs.readdirSync(dir).filter(name=>{const parsed=path.parse(name);const suffix=parsed.name.slice(base.length);return parsed.name.startsWith(base)&&(!suffix||/^_\d+$/.test(suffix))&&['.mp4','.mov'].includes(parsed.ext.toLowerCase());}).map(name=>path.join(dir,name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs);
  for(const file of files){
    if(signal?.aborted)throw new Cancelled();
    try{const checked=await probe(tools.ffprobe,file,signal);validate(checked,info.duration);if((checked.streams||[]).filter(s=>s.codec_type==='audio').length!==(info.audioIndices||[]).length)continue;return file;}catch(e){if(e.name==='Cancelled')throw e;}
  }
  return '';
}
function validate(data,expected){
  const s=(data.streams||[]).find(s=>s.codec_type==='video');
  if(!s||s.color_primaries!=='bt709'||s.color_transfer!=='bt709'||s.color_space!=='bt709'||s.color_range!=='tv')throw Error('输出 Rec.709 标签验证失败');
  const side=[...(s.side_data_list||[]),...(data.frames||[]).flatMap(f=>f.side_data_list||[])];
  if(side.some(x=>/DOVI|Dolby|HDR|Mastering display|Content light/i.test(x.side_data_type||'')))throw Error('输出仍残留 HDR 元数据');
  const duration=Number(s.duration||data.format?.duration||0);
  if(!duration||Math.abs(duration-expected)>Math.max(0.3,expected*0.005))throw Error('输出时长验证失败');
}
async function convert(tools,source,info,{mode='hevc',root='',signal,onProgress=()=>{}}={}){
  const output=outputPath(source,root,mode),temp=output+'.partial'+path.extname(output),log=output+'.log';
  const args=buildArgs(source,temp,info,mode);
  try{
    fs.writeFileSync(log,JSON.stringify({source,output,info,args},null,2));
    await run(tools.ffmpeg,args,{signal,onLine:line=>{const m=/^out_time_us=(\d+)/.exec(line);if(m)onProgress(Math.min(99,Number(m[1])/1e6/info.duration*100));}});
    if(signal?.aborted)throw new Cancelled();
    const checked=await probe(tools.ffprobe,temp,signal,true);
    validate(checked,info.duration);
    if((checked.streams||[]).filter(s=>s.codec_type==='audio').length!==(info.audioIndices||[]).length)throw Error('输出音轨数量验证失败');
    fs.renameSync(temp,output);onProgress(100);return output;
  }catch(e){fs.appendFileSync(log,'\n'+e.stack);if(fs.existsSync(temp))fs.unlinkSync(temp);throw e;}
}
async function checkTools(tools,signal){
  for(const exe of [tools.ffmpeg,tools.ffprobe])if(!fs.existsSync(exe))throw Error(`找不到工具：${exe}`);
  const help=await run(tools.ffmpeg,['-hide_banner','-h','filter=libplacebo'],{signal,timeout:15000});
  if(!help.includes('apply_dolbyvision'))throw Error('FFmpeg 需要支持 libplacebo 与 Dolby Vision');
  const decoders=await run(tools.ffmpeg,['-hide_banner','-decoders'],{signal,timeout:15000});
  tools.audioDecoders=decoders.split(/\r?\n/).map(line=>/^\s*A\S{5}\s+(\S+)/.exec(line)?.[1]).filter(Boolean);
  await run(tools.ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=size=32x32:duration=0.1','-vf','libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709','-f','null','-'],{signal,timeout:30000});
}
module.exports={run,probe,classify,outputPath,buildArgs,validate,convert,checkTools,checkEncoder,findExisting,Cancelled};
