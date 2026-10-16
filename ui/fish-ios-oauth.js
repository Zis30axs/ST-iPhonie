/* ST-iPhonie: experimental manual OAuth/PKCE flow on iOS TauriTavern.
 * No Node server, no cookie extraction, no blind paid speech requests.
 */
import {copyText} from './common.js';
import {probeNativeMcp} from '../fish-mobile/native-probe.js';
import {resolveNativeHost} from '../fish-mobile/native-host.js';
const ENDPOINT = 'https://api.fish.audio/mcp';
const CALLBACK = 'http://127.0.0.1:49152/oauth/callback';
const STORE = 'st-iphonie-fish-ios-pkce-v1';
function url(raw, kind, callback=false) {
  let u; try { u=new URL(String(raw).trim()); } catch { throw Error(kind+' 不是有效 URL'); }
  const loopback=['127.0.0.1','localhost','[::1]'].includes(u.hostname);
  if (u.username||u.password||u.hash) throw Error(kind+' 不能包含凭据或片段');
  if(u.protocol!=='https:' && !(callback && loopback && u.protocol==='http:'))
    throw Error(kind+' 需要 HTTPS（仅手动回调允许 loopback HTTP）');
  return u;
}
function base64url(bytes) {
  let s=''; for(const x of bytes)s+=String.fromCharCode(x);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
async function pkce(w) {
  if(!w.crypto?.subtle?.digest||!w.crypto.getRandomValues)throw Error('当前 WebView 不支持 PKCE 所需的安全 Web Crypto');
  const verifier=base64url(w.crypto.getRandomValues(new Uint8Array(48)));
  const state=base64url(w.crypto.getRandomValues(new Uint8Array(24)));
  const d=new Uint8Array(await w.crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)));
  return {verifier,state,challenge:base64url(d)};
}
async function json(w,target,init={}) {
  url(target,'OAuth 端点');
  let r;try{r=await w.fetch(target,{mode:'cors',credentials:'omit',cache:'no-store',redirect:'error',...init});}
  catch(e){throw Error('WebView 网络或 CORS 失败：'+String(e?.message||'fetch failed')+'；禁用 ST 校验不能关闭浏览器 CORS');}
  let x;try{x=await r.json();}catch{throw Error('OAuth 服务器未返回 JSON，HTTP '+r.status);}
  if(!r.ok)throw Error('OAuth 返回 HTTP '+r.status+'：'+String(x.error||x.message||'拒绝').slice(0,100));
  return x;
}
async function metadata(w,manual) {
  let issuer=manual.issuer,auth=manual.auth,token=manual.token,registration=manual.registration;
  if(!issuer) {
    for(const p of ['/mcp','']) {
      try {
        const x=await json(w,'https://api.fish.audio/.well-known/oauth-protected-resource'+p);
        if(x.resource && x.resource!==ENDPOINT)throw Error('OAuth resource 与 Fish MCP 不一致');
        if(x.authorization_servers?.length){issuer=x.authorization_servers[0];break;}
      }catch{ /* try next RFC9728 location */ }
    }
    if(!issuer)throw Error('无法自动读取 Fish OAuth 资源元数据。可能是 CORS；可在高级选项粘贴官方发现结果');
  }
  issuer=url(issuer,'OAuth Issuer').href.replace(/\/$/,'');
  if(!auth || !token) {
    const u=new URL(issuer),suffix=u.pathname==='/'?'':u.pathname.replace(/\/$/,'');
    const urls=[u.origin+'/.well-known/oauth-authorization-server'+suffix,
      u.origin+'/.well-known/openid-configuration'+suffix,
      issuer+'/.well-known/openid-configuration'];
    let found;
    for(const x of new Set(urls)) {
      try{const d=await json(w,x);if(d.authorization_endpoint&&d.token_endpoint){found=d;break;}}
      catch{ /* try next spec-defined discovery URL */ }
    }
    if(!found)throw Error('OAuth 授权服务器元数据不可读（可能 CORS），请提供官方实际端点');
    if(String(found.issuer||'').replace(/\/$/,'')!==issuer)throw Error('OAuth Issuer 不一致');
    if(found.code_challenge_methods_supported && !found.code_challenge_methods_supported.includes('S256'))
      throw Error('授权服务器未支持 S256 PKCE');
    auth=found.authorization_endpoint;token=found.token_endpoint;registration=found.registration_endpoint;
  }
  return {auth:url(auth,'Authorize URL').href,token:url(token,'Token URL').href,
    registration:registration?url(registration,'Register URL').href:'',issuer};
}
export function readManualCallback(raw,pending,now=Date.now()) {
  if(!pending?.verifier||!pending?.state)throw Error('没有待完成的 OAuth 请求');
  if(now-pending.started>600000||now<pending.started-30000)throw Error('请求超过 10 分钟，请重新授权');
  let u;try{u=new URL(String(raw).trim());}catch{throw Error('请粘贴完整回调 URL');}
  const target=new URL(pending.redirect);
  if(u.origin!==target.origin||u.pathname!==target.pathname)throw Error('OAuth redirect_uri 不一致');
  if(u.searchParams.has('error'))throw Error('授权被拒绝：'+u.searchParams.get('error'));
  if(u.searchParams.getAll('state').length!==1||u.searchParams.get('state')!==pending.state)
    throw Error('OAuth state 不一致');
  if(u.searchParams.getAll('code').length!==1||!u.searchParams.get('code'))throw Error('回调缺少 code');
  return u.searchParams.get('code');
}
export async function temporaryNativeDiscovery(host,bearer) {
  const result=await probeNativeMcp(host,ENDPOINT,bearer);
  return {tools:result.toolNames.map(nativeName=>({nativeName})),protocolVersion:result.protocolVersion};
}
export function openFishIosOAuth(ctx) {
  const w=ctx.win,s=w.sessionStorage;
  let pending=null,accessToken='',loginLink='';
  try{pending=JSON.parse(s.getItem(STORE)||'null');}catch{}
  const fields=[
    ['redirect','手动回调 URL',CALLBACK],['issuer','Issuer（自动发现失败时填）',''],
    ['auth','Authorization endpoint',''],['token','Token endpoint',''],
    ['registration','Dynamic Client Registration endpoint',''],['client','自行注册的公共 Client ID','']
  ];
  const input=([key,label,value])=>'<label class="field"><span>'+label+'</span><input type="text" data-fish-field="'+key+'" value="'+value+'" spellcheck="false" autocomplete="off"></label>';
  const button=(op,label)=>'<button type="button" class="secondary" data-fish-ios-action="'+op+'">'+label+'</button>';
  const html=['<div class="group pad" style="display:grid;gap:9px">',
    '<p class="hint">iPhone 无电脑 OAuth 实验。验证 Safari 手动回调、Token 交换及原生 MCP 工具读取；不自动配音、不扣生成积分。</p>',
    input(fields[0]),'<details><summary>高级：官方 OAuth 端点与公共 Client ID</summary><div class="group pad">',
    ...fields.slice(1).map(input),'</div></details>',
    '<div class="actions">',button('discover','① 发现 OAuth'),button('authorize','② 生成 Fish 登录链接'),'</div>',
    '<p data-fish-status class="hint">尚未开始。</p>',
    '<a data-fish-link target="_blank" rel="noopener noreferrer" hidden>在 Safari 登录 Fish</a>',
    button('copy','复制登录链接'), button('verify','检查 client_id / redirect_uri'),
    '<p class="hint">Safari 回跳到无监听的 localhost 可能失败；只有地址栏仍保留完整 code/state URL 时才可手动复制。不要将回调 URL 发给别人。</p>',
    '<textarea data-fish-field="callback" rows="3" placeholder="③ 粘贴 Safari 的完整回调 URL"></textarea>',
    button('exchange','④ WebView 交换 Access Token'),
    button('mcp','⑤ 原生 MCP 读取工具（不扣语音积分）'),
    '<pre data-fish-result style="max-height:180px;overflow:auto;overflow-wrap:anywhere;white-space:pre-wrap"></pre>',
    '<p class="hint">PKCE state/verifier 在 sessionStorage 暂留最多 10 分钟；Token 只在此窗口内存。原生 MCP Manager 可能短暂落盘 Bearer，测试后立即删除注册。若删除失败会明确提示。</p>',
    '</div>'].join('');
  const sheet=ctx.dialog('Fish MCP · iOS OAuth 实验',html,{top:true});
  const query=id=>sheet.body.querySelector('[data-fish-field="'+id+'"]');
  const value=id=>query(id)?.value.trim()||'';
  const status=(text,bad=false)=>{const el=sheet.body.querySelector('[data-fish-status]');if(el){el.textContent=text;el.style.color=bad?'#c55':'';}};
  const verifyLoginLink=()=>{
    if(!loginLink)throw Error('尚未生成登录链接。');
    const u=new URL(loginLink);
    for(const key of ['response_type','client_id','redirect_uri','state','code_challenge','code_challenge_method']){
      if(u.searchParams.getAll(key).length!==1||!u.searchParams.get(key)?.trim())throw Error('OAuth URL 缺少或重复 '+key+'；请重新生成。');
    }
    if(u.searchParams.get('response_type')!=='code'||u.searchParams.get('code_challenge_method')!=='S256')
      throw Error('OAuth URL 的授权码或 PKCE 格式无效。');
    if(pending && (u.searchParams.get('client_id')!==pending.client||u.searchParams.get('redirect_uri')!==pending.redirect))
      throw Error('OAuth URL 的 client_id / redirect_uri 与注册结果不一致。');
    return u.origin+u.pathname;
  };
  const show=text=>{const el=sheet.body.querySelector('[data-fish-result]');if(el)el.textContent=text;};
  const manual=()=>Object.fromEntries(['issuer','auth','token','registration'].map(x=>[x,value(x)]));
  if(pending?.state&&Date.now()-pending.started<600000)status('恢复了待完成的 PKCE 会话，可直接粘贴 Safari 回调。');
  sheet.body.addEventListener('click',async e=>{
    const b=e.target.closest('[data-fish-ios-action]');if(!b)return;
    b.disabled=true;
    try{
      const op=b.dataset.fishIosAction;
      if(op==='discover'){
        status('从当前 iOS WebView 读取 OAuth Metadata…');
        const x=await metadata(w,manual());
        show(JSON.stringify({issuer:x.issuer,registration:!!x.registration,resource:ENDPOINT},null,2));
        status('成功读到授权元数据，不涉及语音生成。');
      }else if(op==='authorize'){
        const redirect=url(value('redirect'),'Redirect URI',true).href;
        status('正在注册 OAuth 公共客户端并生成 PKCE…');
        const x=await metadata(w,manual());let client=value('client');
        if(!client){
          if(!x.registration)throw Error('无动态注册接口；需合法的公共 Client ID（不能冒用其他 App）');
          const reg=await json(w,x.registration,{method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({client_name:'ST-iPhonie iOS Probe',redirect_uris:[redirect],
              grant_types:['authorization_code','refresh_token'],response_types:['code'],
              token_endpoint_auth_method:'none'})});
          if(reg.token_endpoint_auth_method&&reg.token_endpoint_auth_method!=='none')
            throw Error('服务要求保密 client_secret，浏览器扩展不能安全使用');
          client=reg.client_id;
        }
        if(!client)throw Error('客户端注册未返回 client_id');
        const c=await pkce(w);
        pending={redirect,verifier:c.verifier,state:c.state,client,token:x.token,started:Date.now()};
        s.setItem(STORE,JSON.stringify(pending));
        const u=new URL(x.auth);
        for(const [k,v] of Object.entries({response_type:'code',client_id:client,redirect_uri:redirect,
          state:c.state,code_challenge:c.challenge,code_challenge_method:'S256',resource:ENDPOINT}))
          u.searchParams.set(k,v);
        loginLink=u.href;
        const checkedHost=verifyLoginLink();
        const a=sheet.body.querySelector('[data-fish-link]');a.href=loginLink;a.hidden=false;
        status('登录 URL 参数齐全（client_id ✓ · redirect_uri ✓ · PKCE ✓）：'+checkedHost+'。如 Safari 报缺参，请复制完整 URL 直接粘贴地址栏。');
      }else if(op==='copy'){
        verifyLoginLink();
        if(!await copyText(w,loginLink))throw Error('复制失败，请点击上面的登录链接');
        status('已复制包含 client_id 和 redirect_uri 的完整登录 URL，请直接粘贴 Safari 地址栏。');
      }else if(op==='verify'){
        const host=verifyLoginLink();
        status('登录 URL 已校验：'+host+'；client_id ✓ · redirect_uri ✓ · PKCE ✓。仍报错则检查 Safari 跳转链，不要发原始 URL。');
      }else if(op==='exchange'){
        if(!pending){try{pending=JSON.parse(s.getItem(STORE)||'null');}catch{}}
        const code=readManualCallback(value('callback'),pending);
        const saved=pending;s.removeItem(STORE);pending=null;
        status('WebView 正在向 Token endpoint 发起一次授权码交换（不重试）…');
        const t=await json(w,saved.token,{method:'POST',
          headers:{'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'},
          body:new URLSearchParams({grant_type:'authorization_code',client_id:saved.client,
            redirect_uri:saved.redirect,code,code_verifier:saved.verifier,resource:ENDPOINT}).toString()});
        if(typeof t.access_token!=='string'||!t.access_token)throw Error('Token endpoint 没有返回 Access Token');
        if(t.token_type&&t.token_type.toLowerCase()!=='bearer')throw Error('不支持非 Bearer 令牌');
        accessToken=t.access_token;query('callback').value='';
        status('已取得 Bearer Token，保存在内存中；可以测试原生 MCP。');
      }else if(op==='mcp'){
        if(!accessToken)throw Error('请先完成 Token 交换');
        status('在 TauriTavern MCP Manager 中创建一次性注册并发现工具…');
        const host=await resolveNativeHost(w);
        const got=await temporaryNativeDiscovery(host,accessToken);
        show(JSON.stringify({count:got.tools?.length||0,tools:(got.tools||[]).map(t=>t.nativeName),
          diagnostics:got.diagnostics||[]},null,2));
        status('原生 MCP 发现完成，临时注册已清理。这一步不生成语音。');
      }
    }catch(err){status('✗ '+(err?.message||'未知错误'),true);}
    finally{if(sheet.live)b.disabled=false;}
  });
  sheet.onClose(()=>{accessToken='';});
  return sheet;
}
