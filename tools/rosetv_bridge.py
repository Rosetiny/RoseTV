"""Local, authenticated adapter: pooled requests, optional site account and window controls."""
import base64
import ctypes
from ctypes import wintypes
import gzip
import ipaddress
import json
import os
import re
import secrets
import select
import shutil
import socket
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse as url
from collections import OrderedDict
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from contextlib import contextmanager, nullcontext
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from html.parser import HTMLParser
from itertools import chain
from pathlib import Path
from email.utils import parsedate_to_datetime

import requests
from requests.adapters import HTTPAdapter
from site_session import SITE, SESSION_FILE, load_session
import site_session

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / 'tools' / 'bridge-config.json'
PORT = 34771
BASE = 'http://127.0.0.1:' + str(PORT)
APP = ROOT / 'App' / 'rosetv-native.exe'
APP_PROCESS = None
FULLSCREEN_STATE = None
WINDOW_STATE_LOCK = threading.Lock()

class WindowPlacement(ctypes.Structure):
    _fields_=[('length',wintypes.UINT),('flags',wintypes.UINT),('showCmd',wintypes.UINT),('minPosition',wintypes.POINT),('maxPosition',wintypes.POINT),('normalPosition',wintypes.RECT)]

class MonitorInfo(ctypes.Structure):
    _fields_=[('size',wintypes.DWORD),('monitor',wintypes.RECT),('work',wintypes.RECT),('flags',wintypes.DWORD)]
if os.name == 'nt':
    for name, arguments in {
        'GetWindowThreadProcessId': [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)],
        'IsWindowVisible': [ctypes.c_void_p], 'IsIconic': [ctypes.c_void_p],
        'IsZoomed': [ctypes.c_void_p], 'ShowWindow': [ctypes.c_void_p, ctypes.c_int],
        'SetForegroundWindow': [ctypes.c_void_p],
        'SetWindowTextW': [ctypes.c_void_p, ctypes.c_wchar_p],
        'GetClassNameW': [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int],
        'PostMessageW': [ctypes.c_void_p, ctypes.c_uint, ctypes.c_size_t, ctypes.c_ssize_t],
        'GetWindowPlacement':[ctypes.c_void_p,ctypes.POINTER(WindowPlacement)],
        'GetWindowRect':[ctypes.c_void_p,ctypes.POINTER(wintypes.RECT)],
        'GetClientRect':[ctypes.c_void_p,ctypes.POINTER(wintypes.RECT)],
        'ClientToScreen':[ctypes.c_void_p,ctypes.POINTER(wintypes.POINT)],
        'SetWindowPlacement':[ctypes.c_void_p,ctypes.POINTER(WindowPlacement)],
        'MonitorFromWindow':[ctypes.c_void_p,ctypes.c_ulong],
        'GetMonitorInfoW':[ctypes.c_void_p,ctypes.POINTER(MonitorInfo)],
        'GetWindowLongPtrW':[ctypes.c_void_p,ctypes.c_int],
        'SetWindowLongPtrW':[ctypes.c_void_p,ctypes.c_int,ctypes.c_ssize_t],
        'SetWindowPos':[ctypes.c_void_p,ctypes.c_void_p,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_uint],
        'SetThreadDpiAwarenessContext':[ctypes.c_void_p],
    }.items():
        getattr(ctypes.windll.user32, name).argtypes = arguments
    for name in ('MonitorFromWindow','SetThreadDpiAwarenessContext'):getattr(ctypes.windll.user32,name).restype=ctypes.c_void_p
    for name in ('GetWindowLongPtrW','SetWindowLongPtrW'):getattr(ctypes.windll.user32,name).restype=ctypes.c_ssize_t
CATALOG = OrderedDict()
CACHE = OrderedDict()
PUBLIC_RECORDS = OrderedDict()
PUBLIC_REVISION = 0
CACHE_SAVE_LOCK = threading.Lock()
PENDING = {}
LOCK = threading.Lock()
REQUEST_CONTEXT = threading.local()
SITE_LOCK = threading.Lock()
SITE_TIMING = {'last': 0, 'blockedUntil': 0}
DOUBAN_CONDITION = threading.Condition()
DOUBAN_QUEUE = {'foreground':0,'active':False}
DOUBAN_TIMING = {'last': 0, 'blockedUntil': 0}
PUBLIC_CACHE_FILE = ROOT / 'tools/catalog-cache.json.gz'

def configuration():
    if not CONFIG_FILE.exists():
        CONFIG_FILE.write_text(json.dumps({'key': secrets.token_urlsafe(32), 'siteSessionAuthorized': False}), encoding='utf-8')
    return json.loads(CONFIG_FILE.read_text(encoding='utf-8'))

CONFIG = configuration()
KEY = CONFIG['key']
REQUEST_TIMES={name:list(CONFIG.get(name+'RequestTimes',[])) for name in ('douban','site')}
REQUEST_LIMITS={'douban':8,'site':12}
DOUBAN_TIMING['blockedUntil']=time.monotonic()+max(0,CONFIG.get('doubanBackoffUntil',0)-time.time())
if CONFIG.get('cacheDirectory'):
    PUBLIC_CACHE_FILE = Path(CONFIG['cacheDirectory']) / 'catalog-cache.json.gz'
CACHE_PICKER_LOCK = threading.Lock()

def network_cache_path():
    return Path(CONFIG['cacheDirectory'])/'Network' if CONFIG.get('cacheDirectory') else browser_profile_path()/'Default/Cache'


def browser_profile_path():
    return Path(CONFIG.get('browserProfileDirectory') or Path.home()/'AppData/Local/com.rosetv.app/EBWebView')

def cache_location_status():
    current=str(Path(CONFIG['cacheDirectory']) if CONFIG.get('cacheDirectory') else network_cache_path())
    pending=CONFIG.get('cacheDirectoryPending','')
    return {'current':current,'pending':pending,'restartRequired':bool(pending),'error':CONFIG.get('cacheDirectoryError','')}

def choose_cache_directory():
    if not CACHE_PICKER_LOCK.acquire(blocking=False): raise ValueError('文件夹选择窗口已经打开')
    try:
        script="""Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'RoseTV cache folder'
$dialog.SelectedPath = $env:ROSETV_CACHE_INITIAL
$ownerWindow = New-Object System.Windows.Forms.Form
$ownerWindow.ShowInTaskbar = $false
$ownerWindow.Opacity = 0
$ownerWindow.TopMost = $true
$ownerWindow.StartPosition = 'CenterScreen'
$ownerWindow.Show()
$ownerWindow.Activate()
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class RosePickerOwner : System.Windows.Forms.IWin32Window {
 public IntPtr Handle { get; private set; }
 public RosePickerOwner(long handle) { Handle = new IntPtr(handle); }
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string cls,string title);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int cx,int cy,uint flags);
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from,uint to,bool attach);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 public static bool FocusDialog() {
  IntPtr window=IntPtr.Zero; uint pid;
  while((window=FindWindowEx(IntPtr.Zero,window,"#32770",null))!=IntPtr.Zero) {
   GetWindowThreadProcessId(window,out pid);
   if(pid!=(uint)System.Diagnostics.Process.GetCurrentProcess().Id)continue;
   uint target=GetWindowThreadProcessId(GetForegroundWindow(),out pid),current=GetCurrentThreadId();
   bool attached=target!=current&&AttachThreadInput(current,target,true);
   try { SetWindowPos(window,new IntPtr(-1),0,0,0,0,67);SetForegroundWindow(window); }
   finally { if(attached)AttachThreadInput(current,target,false); }
   return GetForegroundWindow()==window;
  }
  return false;
 }
}
'@ -ReferencedAssemblies System.Windows.Forms
$actualOwner = $ownerWindow
if ($env:ROSETV_OWNER_HWND -and $env:ROSETV_OWNER_HWND -ne '0') { $actualOwner = New-Object RosePickerOwner -ArgumentList ([long]$env:ROSETV_OWNER_HWND) }
$focusTimer = New-Object System.Windows.Forms.Timer
$focusTimer.Interval = 120
$focusTimer.add_Tick({ if ([RosePickerOwner]::FocusDialog()) { $focusTimer.Stop() } })
$focusTimer.Start()
if ($dialog.ShowDialog($actualOwner) -eq [System.Windows.Forms.DialogResult]::OK) {
 [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))
}
$focusTimer.Dispose()
$ownerWindow.Dispose()
"""
        environment=os.environ.copy();environment['ROSETV_CACHE_INITIAL']=cache_location_status()['pending'] or cache_location_status()['current']
        environment['ROSETV_OWNER_HWND']=str(window_handle() or 0)
        result=subprocess.run(['powershell.exe','-NoProfile','-STA','-EncodedCommand',base64.b64encode(script.encode('utf-16le')).decode()],env=environment,capture_output=True,timeout=300,creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode: raise ValueError('无法打开文件夹选择窗口，请重试')
        encoded=result.stdout.strip()
        if not encoded:return {**cache_location_status(),'cancelled':True}
        selected=Path(base64.b64decode(encoded).decode('utf-8')).resolve()
        if not selected.is_dir():raise ValueError('请选择可用的文件夹')
        destination=selected if selected.name=='RoseTV-Cache' else selected/'RoseTV-Cache'
        destination.mkdir(exist_ok=True)
        (destination/'.rosetv-cache').write_text('RoseTV cache directory',encoding='utf-8')
        with LOCK:
            CONFIG['cacheDirectoryPending']=str(destination);CONFIG.pop('cacheDirectoryError',None)
            CONFIG_FILE.write_text(json.dumps(CONFIG),encoding='utf-8')
        return cache_location_status()
    finally:CACHE_PICKER_LOCK.release()

def activate_cache_directory():
    global PUBLIC_CACHE_FILE
    pending=CONFIG.get('cacheDirectoryPending')
    if not pending:return
    try:
        destination=Path(pending).resolve()
        if not (destination/'.rosetv-cache').is_file():raise ValueError('缓存文件夹暂不可用，请重新选择')
        old_file=PUBLIC_CACHE_FILE.resolve();new_file=destination/'catalog-cache.json.gz'
        old_network=network_cache_path().resolve()
        if old_file.exists() and old_file!=new_file:shutil.copy2(old_file,new_file)
        previous=CONFIG.get('cacheDirectory')
        CONFIG['cacheDirectory']=str(destination);CONFIG.pop('cacheDirectoryPending',None);CONFIG.pop('cacheDirectoryError',None)
        CONFIG_FILE.write_text(json.dumps(CONFIG),encoding='utf-8');PUBLIC_CACHE_FILE=new_file
        # Delete only RoseTV's known network cache, after the old WebView has exited.
        owned=old_network==browser_profile_path()/'Default/Cache' or (previous and (Path(previous)/'.rosetv-cache').is_file())
        if old_network!=destination/'Network' and owned:
            try:shutil.rmtree(old_network)
            except OSError:pass
        if old_file!=new_file and (old_file==ROOT/'tools/catalog-cache.json.gz' or previous and old_file.parent==Path(previous).resolve()):old_file.unlink(missing_ok=True)
    except (OSError,ValueError):
        CONFIG['cacheDirectoryError']='所选缓存文件夹暂不可用，当前仍使用原位置';CONFIG_FILE.write_text(json.dumps(CONFIG),encoding='utf-8')
DEFAULT_PROVIDER_ORIGINS = ('https://www.xn--wcv59z.com', 'https://www.xn--kivn76b41nnhi.com',
    'https://www.xn--10vr61a3xc5x3b.com', 'https://www.xn--74qz10cqsltibh40akss.com', 'https://www.xn--vcsx1ip8b8w4i.com')
PROVIDER_ORIGINS = tuple(dict.fromkeys(CONFIG.get('providerOrigins') or DEFAULT_PROVIDER_ORIGINS))
DOUBAN_MOVIE_ORIGIN = CONFIG.get('doubanMovieOrigin','https://movie.douban.com')
DISCOVERY_LOCK = threading.Lock()
SITE = CONFIG.get('siteOrigin') if CONFIG.get('siteOrigin') in PROVIDER_ORIGINS else SITE
SITE_TIMING['blockedUntil'] = time.monotonic() + max(0, CONFIG.get('siteBackoffUntil',0)-time.time())
HTTP = requests.Session()
HTTP.trust_env = False
HTTP.headers.update({'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'})
HTTP.mount('https://', HTTPAdapter(pool_connections=8, pool_maxsize=12))
HTTP.mount('http://', HTTPAdapter(pool_connections=8, pool_maxsize=12))
API_BACKOFF_UNTIL={host:stamp for host,stamp in CONFIG.get('apiBackoffUntil',{}).items() if stamp>time.time()}
SITE_HTTP = None
PROXY_HTTP = requests.Session()
PROXY_HTTP.trust_env = False
PROXY_HTTP.proxies = {'http': 'http://127.0.0.1:7890', 'https': 'http://127.0.0.1:7890'}
PROXY_HTTP.mount('https://', HTTPAdapter(pool_connections=8, pool_maxsize=12))
MEDIA_ROUTES = OrderedDict()

def site_enabled():
    return configuration().get('siteSessionAuthorized') is True and site_session.has_session(SITE)

def site_client(origin=None):
    global SITE_HTTP
    origin=origin or SITE
    if not configuration().get('siteSessionAuthorized') or not site_session.has_session(origin):
        raise PermissionError('网站登录会话尚未授权；普通资源源可继续使用')
    if SITE_HTTP is None or getattr(SITE_HTTP,'rose_origin',None)!=origin:
        if SITE_HTTP:SITE_HTTP.close()
        data = load_session(origin)
        client = requests.Session()
        client.trust_env = False
        client.rose_origin=origin
        client.headers.update({'User-Agent': data['userAgent'], 'Referer': origin + '/'})
        for cookie in data['cookies']:
            client.cookies.set(cookie['name'], cookie['value'], domain=cookie['domain'], path=cookie['path'])
        client.mount('https://', HTTPAdapter(pool_connections=8, pool_maxsize=12))
        SITE_HTTP = client
    return SITE_HTTP

class LocalRequestBudget(PermissionError):
    def __init__(self, provider, seconds):
        self.provider=provider;self.retry_after=max(1,int(seconds)+1)
        super().__init__(('豆瓣资料' if provider=='douban' else '账号网站')+'请求正在本机排队，约 '+str(self.retry_after)+' 秒后继续')

def reserve_request(provider, background=False):
    now=time.time()
    with LOCK:
        times=REQUEST_TIMES[provider]=[stamp for stamp in REQUEST_TIMES[provider] if now-60<stamp<=now]
        if len(times)>=REQUEST_LIMITS[provider]-(2 if background else 0):
            raise LocalRequestBudget(provider,60-now+times[0])
        times.append(now)

def retry_delay(response=None):
    value=response.headers.get('Retry-After','') if response is not None else ''
    try:return max(900,int(value))
    except ValueError:
        try:return max(900,int(parsedate_to_datetime(value).timestamp()-time.time()))
        except (ValueError,TypeError,OverflowError):return 900

def pause_public_api(address,response=None):
    host=url.urlsplit(address).hostname
    with LOCK:
        API_BACKOFF_UNTIL[host]=time.time()+retry_delay(response)
        for expired in [key for key,stamp in API_BACKOFF_UNTIL.items() if stamp<=time.time()]:API_BACKOFF_UNTIL.pop(expired,None)
        while len(API_BACKOFF_UNTIL)>64:API_BACKOFF_UNTIL.pop(next(iter(API_BACKOFF_UNTIL)))
        config=configuration();config['apiBackoffUntil']=dict(API_BACKOFF_UNTIL);CONFIG.update(config)
        CONFIG_FILE.write_text(json.dumps(config),encoding='utf-8')

def check_request():
    if getattr(REQUEST_CONTEXT, 'cancelled', lambda: False)():
        raise ConnectionAbortedError('The view that requested this data has closed')

def wait_for_request(delay):
    end = time.monotonic() + max(0, delay)
    while True:
        check_request()
        remaining = end - time.monotonic()
        if remaining <= 0:return
        time.sleep(min(0.1, remaining))

def cache_lifetime(key,default=300):
    if key.startswith('catalog:'):return 30*86400 if '/subject_abstract?' in key else 21600
    return 1800 if key.startswith('/res/change/') else default

def cached(key, loader, ttl=300):
    global PUBLIC_REVISION
    persistent=key.startswith(('catalog:','/res/change/'))
    ttl=cache_lifetime(key,ttl)
    with LOCK:
        found = CACHE.get(key) or (PUBLIC_RECORDS.get(key) if persistent else None)
        if found and time.monotonic() - found[0] < ttl:
            return found[1]
        pending = PENDING.get(key)
        owner = pending is None
        if owner: pending = PENDING[key] = Future()
    if not owner:
        end = time.monotonic() + 30
        while True:
            check_request()
            try:return pending.result(timeout=min(0.1,max(0,end-time.monotonic())))
            except FutureTimeout:
                if time.monotonic() >= end:raise
            except ConnectionAbortedError:
                check_request()
                return cached(key,loader,ttl)
    try:
        check_request()
        value = loader()
        # Metadata only, never movie files. Keep the entire cache under 4 MiB.
        size = len(value[0]) if isinstance(value, tuple) else len(json.dumps(value, ensure_ascii=False).encode())
        if size < 1024 * 1024:
            with LOCK:
                CACHE[key] = (time.monotonic(), value, size)
                if persistent:
                    PUBLIC_RECORDS.pop(key,None);PUBLIC_RECORDS[key]=CACHE[key];PUBLIC_REVISION+=1
                    while len(PUBLIC_RECORDS)>512 or sum(row[2] for row in PUBLIC_RECORDS.values())>8*1024*1024:PUBLIC_RECORDS.popitem(last=False)
                while len(CACHE) > 80 or sum(item[2] for item in CACHE.values()) > 4 * 1024 * 1024:
                    CACHE.popitem(last=False)
        pending.set_result(value)
        return value
    except BaseException as error:
        if isinstance(error,ConnectionAbortedError):
            with LOCK:
                if PENDING.get(key) is pending:PENDING.pop(key,None)
        pending.set_exception(error)
        raise
    finally:
        with LOCK:
            if PENDING.get(key) is pending:PENDING.pop(key, None)

def load_public_cache():
    try:
        with gzip.open(PUBLIC_CACHE_FILE, 'rb') as file:
            body = file.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024: return
        now = time.time()
        for key, row in json.loads(body).items():
            if not (key.startswith('catalog:') or key.startswith('/res/change/')): continue
            age = now - row['savedAt']; ttl=cache_lifetime(key)
            if not 0 <= age < ttl: continue
            size = len(json.dumps(row['value'], ensure_ascii=False).encode())
            if size < 1024 * 1024:
                CACHE[key] = (time.monotonic() - age, row['value'], size);PUBLIC_RECORDS[key]=CACHE[key]
            while len(CACHE) > 80 or sum(item[2] for item in CACHE.values()) > 4 * 1024 * 1024: CACHE.popitem(last=False)
            while len(PUBLIC_RECORDS)>512 or sum(item[2] for item in PUBLIC_RECORDS.values())>8*1024*1024:PUBLIC_RECORDS.popitem(last=False)
    except (OSError, EOFError, ValueError, KeyError, TypeError, AttributeError): pass


def save_public_cache():
    now, monotonic = time.time(), time.monotonic()
    with LOCK:
        data = {key:{'savedAt':now-(monotonic-row[0]),'value':row[1]} for key,row in {**PUBLIC_RECORDS,**CACHE}.items()
            if key.startswith('catalog:') or key.startswith('/res/change/')}
    body = json.dumps(data, ensure_ascii=False).encode()
    while len(body)>8*1024*1024 and data:
        data.pop(next(iter(data)));body=json.dumps(data,ensure_ascii=False).encode()
    temporary = PUBLIC_CACHE_FILE.with_suffix('.tmp')
    try:
        with CACHE_SAVE_LOCK:
            temporary.write_bytes(gzip.compress(body))
            os.replace(temporary, PUBLIC_CACHE_FILE)
    except OSError: pass


def pause_site(response=None):
    delay=retry_delay(response)
    SITE_TIMING['blockedUntil'] = time.monotonic() + delay
    with LOCK:
        config = configuration(); config['siteBackoffUntil'] = time.time() + delay
        CONFIG.update(config)
        CONFIG_FILE.write_text(json.dumps(config), encoding='utf-8')

def save_request_state():
    with LOCK:
        config=configuration()
        for provider,times in REQUEST_TIMES.items():config[provider+'RequestTimes']=[stamp for stamp in times if time.time()-60<stamp<=time.time()]
        CONFIG.update(config)
        CONFIG_FILE.write_text(json.dumps(config),encoding='utf-8')

def checkpoint_cache():
    previous=None
    while APP_PROCESS and APP_PROCESS.poll() is None:
        current=(PUBLIC_REVISION,tuple(tuple(times) for times in REQUEST_TIMES.values()))
        if current!=previous:save_public_cache();save_request_state();previous=current
        threading.Event().wait(30)


def remember_site_origin(origin):
    global SITE
    if origin not in PROVIDER_ORIGINS: raise ValueError('备用网址尚未核验')
    if origin != SITE:
        SITE = origin
        config = configuration();config['siteOrigin'] = origin
        CONFIG_FILE.write_text(json.dumps(config), encoding='utf-8')

def provider_origin(value):
    parsed=url.urlsplit(str(value).strip())
    if parsed.scheme!='https' or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment or parsed.port not in (None,443):
        raise ValueError('请输入 HTTPS 网站首页地址，不包含账号、路径或参数')
    normalized='https://'+parsed.hostname.encode('idna').decode().lower()
    safe_url(normalized)
    return normalized

def provider_settings():
    return {'primary':SITE,'backups':[origin for origin in PROVIDER_ORIGINS if origin!=SITE],
        'douban':DOUBAN_MOVIE_ORIGIN,'discovery':CONFIG.get('addressDiscovery',{})}

class PublishedLinks(HTMLParser):
    def __init__(self):
        super().__init__();self.links=[];self.current=None
    def handle_starttag(self,tag,attrs):
        if tag=='a':self.current=[dict(attrs).get('href',''),'']
    def handle_data(self,data):
        if self.current:self.current[1]+=data
    def handle_endtag(self,tag):
        if tag=='a' and self.current:self.links.append(self.current);self.current=None

def refresh_provider_addresses():
    """Read trusted publishers at most once daily. Never send account cookies."""
    global PROVIDER_ORIGINS,DOUBAN_MOVIE_ORIGIN
    with DISCOVERY_LOCK:
        saved=CONFIG.get('addressDiscovery',{})
        if time.time()-saved.get('checkedAt',0)<86400:return provider_settings()
        messages=[];discovered=[]
        for provider,publisher in [('douban','https://www.douban.com/'),('site','https://www.xn--ykq321c.com/')]:
            timing=DOUBAN_TIMING if provider=='douban' else SITE_TIMING
            if time.monotonic()<timing['blockedUntil']:
                messages.append(('豆瓣' if provider=='douban' else '教父')+'正在等待恢复，未检查地址');continue
            try:
                reserve_request(provider)
                with HTTP.get(publisher,timeout=(3,8),stream=True,allow_redirects=False) as response:
                    if response.status_code in (403,429):
                        (pause_public_metadata if provider=='douban' else pause_site)(response)
                        raise ValueError('发布页要求验证，停止检查')
                    response.raise_for_status()
                    parser=PublishedLinks();parser.feed(read_limited(response.iter_content(65536),512*1024).decode('utf-8','replace'))
                for address,label in parser.links:
                    parsed=url.urlsplit(url.urljoin(publisher,address))
                    if provider=='douban':
                        if label.strip()!='豆瓣电影' or not (parsed.hostname or '').endswith('.douban.com'):continue
                        DOUBAN_MOVIE_ORIGIN=provider_origin(parsed.scheme+'://'+parsed.netloc)
                    else:
                        if not re.search('教父|肖申克|阿甘正传|盗梦空间|星际穿越|最新地址|备用地址',label):continue
                        origin=provider_origin(parsed.scheme+'://'+parsed.netloc)
                        if origin not in PROVIDER_ORIGINS and origin not in discovered:discovered.append(origin)
                messages.append(('豆瓣' if provider=='douban' else '教父')+('地址已检查' if parser.links else '发布页暂未提供可读取地址，保留原地址'))
            except (ValueError,requests.RequestException,OSError):messages.append(('豆瓣' if provider=='douban' else '教父')+'发布页暂不可用，保留原地址')
        with LOCK:
            PROVIDER_ORIGINS=tuple(dict.fromkeys([*PROVIDER_ORIGINS,*discovered]))[:13]
            config=configuration();config.update(providerOrigins=list(PROVIDER_ORIGINS),doubanMovieOrigin=DOUBAN_MOVIE_ORIGIN,
                addressDiscovery={'checkedAt':time.time(),'message':'；'.join(messages)})
            CONFIG.update(config);CONFIG_FILE.write_text(json.dumps(config),encoding='utf-8')
        return provider_settings()

def save_provider_settings(data):
    global SITE,PROVIDER_ORIGINS,SITE_HTTP
    if not isinstance(data,dict) or not isinstance(data.get('backups'),list) or len(data['backups'])>12:raise ValueError('最多保存 12 个备用网址')
    primary=provider_origin(data.get('primary',''));origins=tuple(dict.fromkeys([primary,*map(provider_origin,data['backups'])]))
    with LOCK:
        CONFIG['providerOrigins']=list(origins);CONFIG['siteOrigin']=primary
        CONFIG_FILE.write_text(json.dumps(CONFIG),encoding='utf-8')
        previous=SITE_HTTP;SITE_HTTP=None;SITE=primary;PROVIDER_ORIGINS=origins;CACHE.clear()
    if previous:previous.close()
    return provider_settings()


def site_json(path):
    def read():
        with SITE_LOCK:
            if time.monotonic() < SITE_TIMING['blockedUntil']:
                raise PermissionError('账号网站暂时限制访问，已暂停请求；请稍后再试，独立 API 仍可使用')
            wait_for_request(2 - (time.monotonic() - SITE_TIMING['last']))
            try:
                origin=SITE;client=site_client(origin);reserve_request('site')
                try:response=client.get(origin+path,timeout=(3,8),stream=True,allow_redirects=False)
                except requests.ConnectionError:
                    refresh_provider_addresses()
                    alternate=next((candidate for candidate in PROVIDER_ORIGINS if candidate!=origin and site_session.has_session(candidate)),None)
                    if not alternate:raise
                    origin=alternate;reserve_request('site');client=site_client(origin)
                    response=client.get(origin+path,timeout=(3,8),stream=True,allow_redirects=False)
                if response.status_code in (301,302,307,308):
                    redirected = url.urlsplit(url.urljoin(origin + path,response.headers.get('Location','')))
                    origin = redirected.scheme+'://'+redirected.netloc
                    response.close()
                    if origin not in PROVIDER_ORIGINS: raise PermissionError('网站跳转到尚未核验的新域名，请更新来源地址')
                    client=site_client(origin) if site_session.has_session(origin) else HTTP
                    reserve_request('site')
                    response = client.get(origin+redirected.path+('?' + redirected.query if redirected.query else ''), timeout=(3,8),stream=True,allow_redirects=False)
                with response:
                    if response.status_code in (403, 429):
                        pause_site(response)
                        raise PermissionError('网站要求验证或限制访问，已暂停请求 15 分钟')
                    response.raise_for_status()
                    try:
                        data = json.loads(read_limited(response.iter_content(65536), 1024 * 1024))
                    except (ValueError, UnicodeError):
                        pause_site()
                        raise PermissionError('网站要求重新登录或验证，已暂停请求 15 分钟')
                if isinstance(data,dict) and (data.get('refresh') or data.get('code',200) not in (1,200)):
                    pause_site();raise PermissionError('网站需要登录或验证，已暂停访问；独立 API 仍可使用')
                remember_site_origin(origin)
            finally: SITE_TIMING['last'] = time.monotonic()
        if isinstance(data, dict) and (data.get('code', 200) not in (1, 200) or data.get('refresh')):
            raise PermissionError(data.get('msg') or '资源站需要重新登录或验证')
        return data
    return cached(path, read)

def read_limited(chunks, limit):
    body = bytearray()
    for chunk in chunks:
        if len(body) + len(chunk) > limit:
            raise ValueError('资源接口返回内容过大')
        body.extend(chunk)
    return bytes(body)

def assignment(html, name):
    match = re.search(r'_obj\.' + re.escape(name) + r'\s*=', html)
    if not match:
        raise ValueError('资源站页面格式已变化')
    return json.JSONDecoder().raw_decode(html[match.end():].lstrip())[0]

def remember(item):
    CATALOG[item['vod_id']] = item
    while len(CATALOG) > 160:
        CATALOG.popitem(last=False)
    return item

def metadata(directory, identifier, title, year='', remarks='', score=''):
    if directory not in ('mv', 'tv', 'ac') or not re.fullmatch(r'[A-Za-z0-9]+', str(identifier)):
        raise ValueError('资源标识不正确')
    return remember({'vod_id': directory + '_' + str(identifier), 'vod_name': str(title),
        'vod_year': year, 'vod_remarks': remarks, 'vod_douban_score': score,
        'vod_pic': BASE + '/cover/' + directory + '/' + str(identifier) + '?_k=' + KEY,
        'type_name': {'mv': '电影', 'tv': '电视剧', 'ac': '动漫'}[directory],
        'source_code': 'site', 'source_name': '教父资源'})

def site_catalog(kind, page=1, limit=None, cursor=None):
    if kind not in ('mv', 'tv', 'ac') or not 1 <= page <= 100 or (limit is not None and not 1 <= limit <= 24):
        raise ValueError('分类或页码不正确')
    position = (page - 1) * 12 if cursor is None else cursor
    if not 0 <= position < 1200:
        raise ValueError('分页位置不正确')
    items, seen, has_more = [], set(), False
    for _ in range(1 if limit is None else 4):
        raw_page, offset = divmod(position, 12)
        if raw_page >= 100:
            break
        group = site_json('/res/change/' + kind + '/' + str(raw_page + 1))
        identifiers = group.get('i', [])
        def value(name, index, default=''):
            values = group.get(name, [])
            return values[index] if isinstance(values, list) and index < len(values) else default
        for index in range(offset, len(identifiers)):
            position = raw_page * 12 + index + 1
            identifier, status = identifiers[index], value('g', index)
            if status == '预告' or identifier in seen:
                continue
            seen.add(identifier)
            attributes = value('a', index, [])
            item = metadata(kind, identifier, value('t', index), attributes[0] if attributes else '', status, value('d', index))
            region = attributes[1] if len(attributes) > 1 else ''
            item['vod_area'] = region if isinstance(region, str) and re.search(r'[A-Za-z\u4e00-\u9fff]', region) else ''
            item['vod_hits'] = value('w', index, 0)
            items.append(item)
            if limit is not None and len(items) >= limit:
                break
        has_more = position < raw_page * 12 + len(identifiers) or len(identifiers) == 12
        if limit is None or len(items) >= limit or not has_more:
            break
        position = (raw_page + 1) * 12
    return {'kind': kind, 'title': {'mv': '近期热门电影', 'tv': '近期热门剧集', 'ac': '近期热门动漫'}[kind],
        'page': page, 'hasMore': has_more and position < 1200, 'nextCursor': position, 'list': items}

def recommendations(limit=12):
    if not site_enabled():
        return public_recommendations(limit)
    def read_group(kind):
        try: return site_catalog(kind, limit=limit, cursor=0)
        except (requests.RequestException, ValueError, PermissionError):
            data=library(kind,1,limit,{'sort':'U','year':'近三年'})
            return {'kind':kind,'title':'近期热门'+('电影' if kind=='mv' else '剧集'),'list':data['list']}
    with ThreadPoolExecutor(max_workers=2) as pool:
        groups = list(pool.map(read_group, ('mv', 'tv')))
    return {'groups': groups, 'count': sum(len(group['list']) for group in groups)}

def public_recommendations(limit=12):
    def read():
        def category(kind):
            try:
                with HTTP.get('https://www.mdzyapi.com/api.php/provide/vod/',
                    params={'ac': 'videolist', 't': kind, 'pg': 1}, timeout=(2, 3), stream=True) as response:
                    response.raise_for_status()
                    videos = json.loads(read_limited(response.iter_content(65536), 8 * 1024 * 1024)).get('list', [])
            except (requests.RequestException, ValueError):
                return []
            items = []
            for video in videos:
                if re.search('伦理片|福利|色情|里番', video.get('type_name', '')):
                    continue
                item = {key: video.get(key, '') for key in ('vod_id', 'vod_name', 'vod_year', 'vod_pic',
                    'vod_remarks', 'vod_play_url', 'vod_play_from', 'vod_douban_score', 'type_name', 'vod_time')}
                item.update(source_code='mdzy', source_name='魔都资源')
                if str(item.get('vod_pic', '')).startswith(('http://', 'https://')):
                    item['vod_pic'] = media_url(item['vod_pic'], public=True)
                items.append(item)
            return items
        with ThreadPoolExecutor(max_workers=4) as pool:
            categories = list(pool.map(category, (10, 15, 26, 29)))
        groups = []
        for title, items in [('近期电影', categories[0] + categories[1]), ('近期剧集', categories[2] + categories[3])]:
            items.sort(key=lambda item: ((re.search(r'\d{4}', str(item.get('vod_year'))) or ['0'])[0], str(item.get('vod_time', ''))), reverse=True)
            groups.append({'title': title, 'list': list({str(item['vod_id']): item for item in items}.values())[:limit]})
        if not any(group['list'] for group in groups):
            raise ValueError('推荐接口暂时不可用，请重试')
        return {'groups': groups, 'count': sum(len(group['list']) for group in groups)}
    return cached('public-recommendations-' + str(limit), read)

def pause_public_metadata(response=None):
    delay=retry_delay(response)
    DOUBAN_TIMING['blockedUntil']=time.monotonic()+delay
    with LOCK:
        config=configuration();config['doubanBackoffUntil']=time.time()+delay
        CONFIG['doubanBackoffUntil']=config['doubanBackoffUntil']
        CONFIG_FILE.write_text(json.dumps(config),encoding='utf-8')

@contextmanager
def douban_turn(background):
    # One upstream request at a time; visible navigation precedes metadata/prefetch.
    with DOUBAN_CONDITION:
        if not background:DOUBAN_QUEUE['foreground']+=1
        try:
            while DOUBAN_QUEUE['active'] or background and DOUBAN_QUEUE['foreground']:
                check_request()
                DOUBAN_CONDITION.wait(0.1)
            check_request()
            DOUBAN_QUEUE['active']=True
        finally:
            if not background:DOUBAN_QUEUE['foreground']-=1
    try:yield
    finally:
        with DOUBAN_CONDITION:
            DOUBAN_QUEUE['active']=False
            DOUBAN_CONDITION.notify_all()

def public_json(address, background=False):
    if address.startswith('https://movie.douban.com/'):address=DOUBAN_MOVIE_ORIGIN+address[len('https://movie.douban.com'):]
    douban=url.urlsplit(address).hostname in (url.urlsplit(DOUBAN_MOVIE_ORIGIN).hostname,'m.douban.com')
    background=background or url.urlsplit(address).path.endswith('/subject_abstract')
    def valid(data):
        if not douban:return True
        path=url.urlsplit(address).path
        if path.endswith('/recommend'):return isinstance(data,dict) and isinstance(data.get('items'),list)
        if path.endswith('/new_search_subjects'):return isinstance(data,dict) and isinstance(data.get('data',data.get('subjects')),list)
        if path.endswith('/subject_suggest'):return isinstance(data,list)
        if path.endswith('/subject_abstract'):return isinstance(data,dict) and bool(data.get('subject',{}).get('id'))
        return True
    def read():
        with douban_turn(background) if douban else nullcontext():
            if douban:
                if time.monotonic()<DOUBAN_TIMING['blockedUntil']:raise PermissionError('豆瓣暂时限制访问，已暂停新请求；已有缓存仍可浏览，请稍后重试')
                wait_for_request(4-(time.monotonic()-DOUBAN_TIMING['last']))
                reserve_request('douban',background)
                DOUBAN_TIMING['last']=time.monotonic()
            try:
                with upstream(address, headers={'Referer': 'https://m.douban.com/movie/' if url.urlsplit(address).hostname=='m.douban.com' else 'https://movie.douban.com/', 'User-Agent': 'Mozilla/5.0'}) as response:
                    body=read_limited(response.iter_content(65536), 8 * 1024 * 1024)
                    try:data=json.loads(body)
                    except (ValueError,UnicodeError):
                        if douban and re.search(r'captcha|challenge-platform|sec\.douban|异常请求|安全验证|验证码|访问过于频繁',body.decode('utf-8','replace'),re.I):
                            pause_public_metadata(response);raise PermissionError('豆瓣要求网站验证，已暂停新请求至少 15 分钟；已有缓存仍可浏览')
                        if not douban and re.search(rb'captcha|challenge-platform|Just a moment',body[:65536],re.I):
                            pause_public_api(address,response);raise PermissionError('此公开来源要求网站验证，已暂停新请求；请使用其他来源')
                        raise ValueError('资料接口返回了网页，请稍后重试')
            except requests.HTTPError as error:
                if douban and error.response is not None and error.response.status_code in (403,429):
                    pause_public_metadata(error.response);raise PermissionError('豆瓣要求验证或限制访问，已暂停新请求至少 15 分钟；这不代表没有匹配影片')
                raise
            except requests.ConnectionError:
                if douban:refresh_provider_addresses()
                raise
            if douban and isinstance(data,dict) and re.search('异常请求|请登录|频繁|验证',str(data.get('msg',''))):
                pause_public_metadata();raise PermissionError('豆瓣要求验证或限制访问，已暂停新请求 15 分钟；这不代表没有匹配影片')
        if not valid(data):
            message=data.get('msg') if isinstance(data,dict) else None
            raise ValueError('豆瓣资料接口返回异常：'+str(message)[:160] if douban and message else '资料接口暂未返回有效数据，请稍后重试')
        return data
    with LOCK:
        previous=CACHE.get('catalog:'+address) or PUBLIC_RECORDS.get('catalog:'+address)
        if previous and not valid(previous[1]):
            CACHE.pop('catalog:'+address,None);PUBLIC_RECORDS.pop('catalog:'+address,None)
    return cached('catalog:' + address, read)

def subject_info(identifier):
    if not re.fullmatch(r'\d{1,10}',str(identifier)):raise ValueError('影片编号不正确')
    subject=public_json('https://movie.douban.com/j/subject_abstract?subject_id='+str(identifier)).get('subject',{})
    if str(subject.get('id'))!=str(identifier):raise ValueError('影片资料暂不可用')
    return {'vod_year':str(subject.get('release_year') or ''),'vod_area':str(subject.get('region') or ''),
        'vod_class':' / '.join(subject.get('types') or []),'vod_actor':people_text(subject.get('actors')),
        'vod_director':people_text(subject.get('directors')),'vod_douban_id':str(identifier)}

def find_subject_info(title,year=''):
    if not isinstance(title,str) or not 0<len(title)<=150:raise ValueError('片名不正确')
    normalize=lambda value:re.sub(r'[\W_]+','',unicodedata.normalize('NFKC',str(value))).casefold()
    rows=public_json('https://movie.douban.com/j/subject_suggest?q='+url.quote(title))
    if not isinstance(rows,list):raise ValueError('资料搜索暂不可用')
    matches=[row for row in rows if normalize(row.get('title',''))==normalize(title) and (not year or str(row.get('year',''))[:4]==str(year)[:4])]
    if len(matches)!=1:raise ValueError('未找到同片名、同年份的唯一资料')
    return subject_info(matches[0]['id'])

def search_suggestions(keyword):
    keyword=str(keyword).strip()
    if not 1<=len(keyword)<=80:raise ValueError('请输入 1 至 80 个字的片名')
    with LOCK:records=list(PUBLIC_RECORDS.values())
    matches={}
    for stamp,data,_ in reversed(records):
        if not isinstance(data,dict) or time.monotonic()-stamp>21600:continue
        for row in data.get('items',data.get('data',[])):
            if not isinstance(row,dict) or not re.fullmatch(r'\d{1,10}',str(row.get('id',''))):continue
            if keyword.casefold() in str(row.get('title','')).casefold():
                matches[str(row['id'])]={'title':str(row['title'])[:160],'year':str(row.get('year') or '')[:12],'id':str(row['id'])}
    if matches:return {'list':list(matches.values())[:8]}
    rows=public_json('https://movie.douban.com/j/subject_suggest?q='+url.quote(keyword))
    if not isinstance(rows,list):raise ValueError('片名联想暂时无法获取')
    return {'list':[{'title':str(row['title'])[:160],'year':str(row.get('year') or '')[:12],
        'id':str(row.get('id') or '')} for row in rows[:8] if isinstance(row,dict) and row.get('title')]}

def storage_status():
    def size(path):
        total = 0
        for directory, _, files in os.walk(path):
            for name in files:
                try: total += (Path(directory) / name).stat().st_size
                except OSError: pass
        return total
    profile = browser_profile_path()
    external_network=size(network_cache_path()) if CONFIG.get('cacheDirectory') and not network_cache_path().is_relative_to(profile) else 0
    cache_paths = ('Default/Cache', 'Default/Code Cache', 'Default/GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache')
    account_sizes={'total':0,'extensions':0,'siteStorage':0,'cache':0}
    for directory,_,files in os.walk(site_session.LOGIN_DATA):
        parts=set(Path(directory).relative_to(site_session.LOGIN_DATA).parts)
        group='extensions' if parts&{'Extensions','extensions_crx_cache','component_crx_cache'} else 'siteStorage' if parts&{'IndexedDB','Local Storage','Session Storage','Service Worker','Storage'} else 'cache' if parts&{'Cache','Code Cache','GPUCache','ShaderCache','GrShaderCache','GraphiteDawnCache','DawnGraphiteCache','DawnWebGPUCache'} else None
        for name in files:
            try:amount=(Path(directory)/name).stat().st_size
            except OSError:continue
            account_sizes['total']+=amount
            if group:account_sizes[group]+=amount
    with LOCK:
        combined={**PUBLIC_RECORDS,**CACHE};metadata_bytes=sum(item[2] for item in combined.values());metadata_entries=len(combined)
    application_bytes=sum(size(ROOT/folder) for folder in ('App','runtime','vendor','source/public','tools/__pycache__'))+sum(path.stat().st_size for path in (ROOT/'tools').glob('*.py'))
    if (ROOT/'RoseTV.exe').is_file():application_bytes+=(ROOT/'RoseTV.exe').stat().st_size
    profile_bytes=size(profile)+external_network
    snapshot_bytes=PUBLIC_CACHE_FILE.stat().st_size if PUBLIC_CACHE_FILE.exists() else 0
    configuration_bytes=sum(path.stat().st_size for path in (CONFIG_FILE,SESSION_FILE) if path.exists())
    return {'measuredAt': int(time.time()), 'applicationBytes':application_bytes,
        'totalDiskBytes':application_bytes+profile_bytes+account_sizes['total']+snapshot_bytes+configuration_bytes,
        'configurationBytes':configuration_bytes,
        'profileBytes': profile_bytes, 'browserCacheBytes': sum(size(profile / name) for name in cache_paths)+external_network,
        'metadataBytes': metadata_bytes, 'metadataEntries': metadata_entries,
        'savedMetadataBytes': snapshot_bytes,
        'accountBrowserBytes':account_sizes['total'], 'accountBrowserExtensionBytes':account_sizes['extensions'],
        'accountBrowserSiteStorageBytes':account_sizes['siteStorage'], 'accountBrowserCacheBytes':account_sizes['cache'],
        'providerOrigin': SITE, 'providerBackups': [origin for origin in PROVIDER_ORIGINS if origin != SITE],
        'siteCooldownSeconds': max(0,int(SITE_TIMING['blockedUntil']-time.monotonic())),
        'networkCacheBudgetBytes': 32 * 1024 * 1024, 'videoFilesSavedByAdapter': 0,
        'cacheLocation':cache_location_status()}


DOUBAN_GENRES=frozenset('剧情 喜剧 动作 爱情 科幻 动画 悬疑 惊悚 恐怖 纪录片 短片 情色 同性 音乐 歌舞 家庭 儿童 传记 历史 战争 犯罪 西部 奇幻 冒险 灾难 武侠 古装 运动 黑色电影 戏曲 真人秀 脱口秀 舞台艺术'.split())

def catalog_metadata_batch(kind, query, start, cache_only=False):
    # Match exact IDs only: recommendations can differ in order and include charts.
    tags=','.join(filter(None,[query['tags'],query.get('genres'),query.get('countries')]))
    years=query.get('year_range','').split(',')
    if len(years)==2 and years[0]==years[1]:tags+=','+years[0]
    result={}
    for endpoint in (('movie','tv') if kind=='doc' else ('movie',) if kind=='mv' else ('tv',)):
        params={'refresh':0,'start':start,'count':40,'tags':tags,'sort':query['sort'],'score_range':query['range']}
        address='https://m.douban.com/rexxar/api/v2/'+endpoint+'/recommend?'+url.urlencode(params)
        try:
            if cache_only:
                with LOCK:found=CACHE.get('catalog:'+address) or PUBLIC_RECORDS.get('catalog:'+address)
                data=found[1] if found and time.monotonic()-found[0]<21600 else {}
            else:data=public_json(address)
        except (ValueError,requests.RequestException):continue
        for row in data.get('items',[]):
            identifier=str(row.get('id',''))
            if not re.fullmatch(r'\d{1,10}',identifier):continue
            parts=str(row.get('card_subtitle') or '').split(' / ')
            genres=[value for value in parts[2].split() if value in DOUBAN_GENRES] if len(parts)>2 else []
            result[identifier]={'vod_year':str(row.get('year') or ''),'vod_area':parts[1] if len(parts)>1 else '',
                'vod_class':' / '.join(genres)}
    return result

def rich_catalog(kind,page,limit,query,background=False):
    # Raw batches and display pages have separate cursors: charts never leave holes.
    batch=limit*4
    tags=','.join(filter(None,[query['tags'],query.get('genres'),query.get('countries')]))
    years=query.get('year_range','').split(',')
    if len(years)==2 and years[0]==years[1]:tags+=','+years[0]
    endpoint='movie' if kind=='mv' else 'tv'
    params={'refresh':0,'count':batch,'tags':tags,'sort':query['sort'],'score_range':query['range']}
    base='https://m.douban.com/rexxar/api/v2/'+endpoint+'/recommend?'+url.urlencode(params)
    def address(start,count):
        return 'https://m.douban.com/rexxar/api/v2/'+endpoint+'/recommend?'+url.urlencode({'refresh':0,'start':start,**{key:value for key,value in params.items() if key!='refresh'},'count':count})
    previous={'cursor':0,'seen':[],'rows':[],'hasMore':True,'total':None,'block':None}
    for number in range(1,page+1):
        def read(previous=previous):
            position=previous['cursor'];seen=set(previous['seen']);rows=[];total=previous['total'];more=previous['hasMore'];block=previous['block']
            while len(rows)<limit and more:
                if block is None:
                    # Existing 32-item snapshots remain useful after increasing new batches.
                    with LOCK:found=CACHE.get('catalog:'+address(position,limit*2)) or PUBLIC_RECORDS.get('catalog:'+address(position,limit*2))
                    block=[position,limit*2 if found and time.monotonic()-found[0]<21600 else batch]
                start,count=block
                data=public_json(address(start,count),background=background)
                if not isinstance(data,dict) or not isinstance(data.get('items'),list):raise ValueError('资料接口暂未返回有效片单，请稍后重试')
                raw=data['items'];total=int(data['total']) if str(data.get('total','')).isdigit() else None
                for row in raw[position-start:]:
                    position+=1;identifier=str(row.get('id',''))
                    if re.fullmatch(r'\d{1,10}',identifier) and identifier not in seen:
                        seen.add(identifier);rows.append(row)
                    if len(rows)==limit:break
                more=bool(raw) and (position<total if total is not None else position<start+len(raw) or len(raw)==count)
                if position>=start+len(raw):block=None
            return {'cursor':position,'seen':sorted(seen),'rows':rows,'total':total,'hasMore':more,'block':block}
        previous=cached('catalog:dense-v2:'+base+'&page='+str(number),read)
        if not previous['hasMore'] and number<page:
            return {'list':[],'page':page,'pages':number,'hasMore':False,'provider':'豆瓣影片资料','note':'已到影片目录末尾'}
    items=[]
    for row in previous['rows']:
        identifier=str(row.get('id',''))
        if not re.fullmatch(r'\d{1,10}',identifier):continue
        parts=str(row.get('card_subtitle') or '').split(' / ')
        cover=(row.get('pic') or {}).get('large') or row.get('cover') or ''
        items.append({'vod_id':identifier,'vod_douban_id':identifier,'vod_name':row.get('title',''),
            'vod_year':str(row.get('year') or (parts[0] if parts else '')),
            'vod_area':parts[1] if len(parts)>1 else '',
            'vod_class':' / '.join(value for value in parts[2].split() if value in DOUBAN_GENRES) if len(parts)>2 else '',
            'vod_douban_score':(row.get('rating') or {}).get('value') or '',
            'vod_pic':media_url(cover,public=True) if cover and not re.search('default_|nopic',cover,re.I) else '',
            'source_code':'metadata','type_name':{'mv':'电影','tv':'电视剧','ac':'动漫','variety':'综艺'}[kind]})
    total=previous['total'];removed=previous['cursor']-len(previous['seen'])
    result={'list':items,'page':page,'hasMore':previous['hasMore'],'provider':'豆瓣影片资料','note':'年份、地区、类型随片单一起读取；推荐结果范围由资料源决定'}
    if removed:result['note']+='；已略过榜单等非影片卡片并连续补齐分页'
    if not previous['hasMore']:result['pages']=max(1,page)
    elif total is not None:result['pages']=max(page,(total-removed+limit-1)//limit)
    return result

def source_filter_catalog(kind,page,limit,filters,identifiers=None):
    # Explicit source fields only; this bounded batch is not the complete movie catalogue.
    topics=[value for value in filters.get('genre','').split(',') if value and value not in DOUBAN_GENRES and value!='纪录']
    if topics:
        return {'list':[],'page':1,'pages':1,'hasMore':False,'unsupportedFilters':topics,'provider':'来源字段筛选',
            'note':'资源接口未提供“'+ '、'.join(topics)+'”的题材标签，无法与来源画质、完结状态或任意/排除类型精确组合；请改用单选/同时匹配，或取消来源画质、状态条件。'}
    types={'mv':[11,6,7,8,9,10,12,20,21,22,23,24,25,26,27,28,29,43,45],
        'tv':[13,14,15,16,30,31,32,33],'ac':[38,39,40],'variety':[34,35,36,37],'doc':[27]}[kind]
    types=identifiers or types
    start=int(filters.get('cursor') or 0);items=[];position=start;has_more=True
    for _ in range(2):
        block,row_index=divmod(position,20);identifier=types[block%len(types)];upstream_page=block//len(types)+1
        data=public_json('https://360zy.com/api.php/provide/vod/?'+url.urlencode({'ac':'detail','t':identifier,'pg':upstream_page}))
        rows=data.get('list')
        if not isinstance(rows,list):raise ValueError('语言资料接口暂时不可用，请稍后重试')
        for index in range(row_index,min(20,len(rows))):
            position=block*20+index+1;video=rows[index]
            if not matches_catalog_filters(video,filters):continue
            item=dict(video);item.update(source_code='zy360',source_name='360资源')
            if str(item.get('vod_pic','')).startswith(('http://','https://')):item['vod_pic']=media_url(item['vod_pic'],public=True)
            items.append(item)
            if len(items)>=limit:break
        if len(items)>=limit:break
        position=(block+1)*20
        if len(types)==1 and upstream_page>=int(data.get('pagecount') or max(1,(int(data.get('total') or 0)+19)//20)):
            has_more=False;break
    return {'list':items,'page':page,'nextCursor':position,'hasMore':has_more,'provider':'360资源 API',
        'note':('豆瓣目录不支持精确语言筛选，按资源的语言标注筛选；' if filters.get('lang') else '按资源的类型、画质和状态标注筛选；')+'每次最多读取两批，按来源顺序展示，本批未满可继续下一批'}

def library(kind, page, limit, filters, details=True, background=False, rich=False):
    types = {'mv': 1, 'tv': 2, 'ac': 4, 'variety': 3, 'doc': 19}
    if kind not in types or not 1 <= page <= 10000 or not 1 <= limit <= 24:
        raise ValueError('分类、页码或数量不正确')
    genre = filters.get('genre', '')
    mode = filters.get('genreMode') or 'single'
    if mode not in ('single', 'any', 'all', 'exclude'):
        raise ValueError('类型组合方式不正确')
    subtypes = {'mv': {'动作':6,'喜剧':7,'爱情':8,'科幻':9,'恐怖':10,'剧情':11,'战争':12,'惊悚':20,'家庭':21,'古装':22,'历史':23,'悬疑':24,'犯罪':25,'灾难':26,'纪录':27,'短片':28,'动画':29,'西部':45}}
    needs_metadata = not ((mode in ('any','exclude') and genre) or filters.get('quality') not in ('',None,'clear') or filters.get('status'))
    items = []
    if not needs_metadata:
        identifiers=[subtypes[kind][genre]] if genre and mode=='single' and genre in subtypes.get(kind,{}) else None
        return source_filter_catalog(kind,page,limit,filters,identifiers)
    tags = {'mv': '电影', 'tv': '电视剧', 'ac': '动漫', 'variety': '综艺', 'doc': '纪录片'}[kind]
    requested_genre=','.join(sorted({'纪录片' if value=='纪录' else value for value in genre[:500].split(',') if value}))
    formal_genre=requested_genre if requested_genre in DOUBAN_GENRES else ''
    if requested_genre and not formal_genre:tags+=','+requested_genre
    if filters.get('lang'): tags += ',' + filters['lang'][:30]
    sort = filters.get('sort') or 'U'
    if sort == 'T': sort='S'  # Legacy RoseTV labelled T as score; Douban's score order is S.
    query = {'tags': tags, 'sort': 'R' if sort == 'N' else sort, 'range': (filters.get('rating') or '0') + ',10',
        'genres': ('真人秀' if kind == 'variety' and not genre else formal_genre), 'countries': filters.get('region', '')[:30]}
    year = filters.get('year') or ('近三年' if sort == 'N' else '')
    match = re.fullmatch(r'(\d{4})(年代)?', year)
    if match:
        query['year_range'] = match[1] + ',' + str(int(match[1]) + (9 if match[2] else 0))
    elif year == '近三年':
        current_year = time.localtime().tm_year
        query['year_range'] = str(current_year - 2) + ',' + str(current_year)
    elif year == '更早':
        query['year_range'] = '1888,1959'
    if rich and kind in ('mv','tv','ac','variety') and (not year or match and not match[2]):
        result=rich_catalog(kind,page,limit,query,background)
        if filters.get('lang'):
            result['note']+='；语言按上游标签索引，非完整语言片库'
            if not result['list'] and not result['hasMore']:result['emptyReason']='language-index'
        return result
    offset = (page - 1) * limit
    target, metadata_total = limit + 1, None
    # Arbitrary offsets are supported; one request covers a normal 16-card page.
    for block_start in range(offset,offset+target,20):
        query.update(start=block_start, count=20)
        address='https://movie.douban.com/j/new_search_subjects?' + url.urlencode(query)
        data=public_json(address,background=True) if background else public_json(address)
        if not isinstance(data,dict) or not ('data' in data or 'subjects' in data): raise ValueError('影片目录返回格式异常')
        if re.fullmatch(r'\d{1,9}',str(data.get('total',''))): metadata_total=int(data['total'])
        rows = data.get('data', data.get('subjects', []))
        if not isinstance(rows,list): raise ValueError('影片目录返回格式异常')
        try:metadata=catalog_metadata_batch(kind,query,block_start,cache_only=not details) if rows else {}
        except PermissionError:metadata={}  # A verification pause also covers the mobile endpoint.
        for video in rows[max(0,offset-block_start):min(20,offset+target-block_start)]:
            cover = video.get('cover') or (video.get('pic') or {}).get('large') or ''
            if not isinstance(cover,str) or re.search(r'(?:movie|tv)_default|default_(?:large|small)|nopic',cover,re.I): cover=''
            rating = video.get('rate') or (video.get('rating') or {}).get('value') or ''
            fields=metadata.get(str(video['id']),{})
            items.append({'vod_id': str(video['id']), 'vod_name': video.get('title', ''), 'vod_year': fields.get('vod_year') or video.get('year', ''),
                'vod_pic': media_url(cover, public=True) if cover else '', 'vod_douban_score': rating,
                'vod_actor': people_text(video.get('casts')), 'vod_director': people_text(video.get('directors')),
                'vod_douban_id':str(video['id']), 'vod_class':fields.get('vod_class') or formal_genre,'vod_area':fields.get('vod_area',''),
                'source_code': 'metadata', 'type_name': tags.split(',')[0]})
        if len(items) >= target or len(rows)<20: break
    result = {'list': items[:limit], 'page': page, 'hasMore': len(items)>limit,'provider':'豆瓣影片资料', 'note':('近三年上映 · ' if sort == 'N' and not filters.get('year') else '')+'封面、类型与评分资料；点击后在已启用来源中匹配播放'+('；播放时排除抢先版，未标注画质暂保留' if filters.get('quality')=='clear' else '')}
    if not details:result['metadataPending']=any(not (item['vod_year'] and item['vod_area'] and item['vod_class']) for item in result['list'])
    if metadata_total is not None:
        result.update(total=metadata_total,pages=max(1,(metadata_total+limit-1)//limit))
    elif not result['hasMore'] and (items or page==1):
        result.update(total=offset+len(items),pages=page)
    if filters.get('lang'):
        result['note']+='；语言按上游标签索引，非完整语言片库'
        if not result['list'] and not result['hasMore']:result['emptyReason']='language-index'
    return result


def people_text(values):
    if isinstance(values,str): return values
    return ' / '.join(str(value.get('name') or '') if isinstance(value,dict) else str(value) for value in values or [])

def matches_catalog_filters(video, filters):
    genres = [value for value in filters.get('genre','')[:500].split(',') if value]
    text = str(video.get('vod_class','')) + ',' + str(video.get('type_name',''))
    mode = filters.get('genreMode') or 'single'
    if mode == 'exclude':
        classes={value.strip().removesuffix('片') for value in re.split(r'[,，/\s]+',str(video.get('vod_class',''))) if value.strip()}
        if any(value in genres for value in ('恐怖','惊悚','丧尸')) and len(classes) < 2: return False
        text += ' '+str(video.get('vod_tag',''))+' '+str(video.get('vod_blurb',''))+' '+str(video.get('vod_content',''))
        aliases={'恐怖':r'恐怖|horror|闹鬼|恶灵|厉鬼|灵异|鬼魂|鬼屋','惊悚':r'惊悚|惊恐|thriller','丧尸':r'丧尸|僵尸|活死人|行尸|zombie'}
        matched=[bool(re.search(aliases[value],text,re.I)) if value in aliases else value in text for value in genres]
        if not str(video.get('vod_class') or video.get('type_name') or '').strip(): return False
    else: matched = [value.replace('纪录','记录') in text.replace('纪录','记录') for value in genres]
    if matched and not (not any(matched) if mode == 'exclude' else all(matched) if mode == 'all' else any(matched)): return False
    current_year = time.localtime().tm_year
    year = filters.get('year','')
    if year:
        numbers = re.findall(r'\d{4}',str(video.get('vod_year','')))
        years = (current_year-2,current_year) if year == '近三年' else (1888,1959) if year == '更早' else (int(year[:4]),int(year[:4])+(9 if '年代' in year else 0))
        if not numbers or not years[0] <= int(numbers[0]) <= years[1]: return False
    for key,field in (('region','vod_area'),('lang','vod_lang')):
        if filters.get(key):
            value=str(video.get(field,''));wanted=filters[key]
            if key=='lang' and wanted=='汉语普通话':
                if not re.search('汉语普通话|普通话|国语',value):return False
            elif wanted.replace('中国','') not in value.replace('中国',''):return False
    if filters.get('rating'):
        try: score = float(video.get('vod_douban_score') or 0)
        except (ValueError, TypeError): score = 0
        if score < float(filters['rating']): return False
    quality = filters.get('quality','')
    annotations = str(video.get('vod_remarks',''))+' '+str(video.get('vod_version',''))
    if quality=='clear' and re.search(r'枪版|抢先|偷拍|\b(?:TC|TS|CAM)\b',annotations+' '+str(video.get('vod_name','')),re.I):return False
    if quality and quality != 'clear':
        patterns = {'4k':r'4K|2160|UHD','1080':r'1080|FHD','720':r'720','hd':r'HD|高清|蓝光|1080|2160|4K','clear':r'枪版|抢先|TC|CAM|TS'}
        if quality not in patterns: raise ValueError('画质条件不正确')
        found = re.search(patterns[quality],annotations,re.I)
        if (quality == 'clear' and found) or (quality != 'clear' and not found): return False
    status = filters.get('status','')
    if status and str(video.get('vod_isend','')) != ('1' if status == 'finished' else '0'): return False
    return True


def expand_episodes(values):
    result = []
    for value in values:
        if not isinstance(value, list):
            result.append(str(value))
            continue
        (prefix, suffix), numbers = value
        if isinstance(numbers, list):
            numbers = range(int(numbers[0]), min(int(numbers[1]), int(numbers[0]) + 1000) + 1)
        else:
            numbers = [numbers]
        result.extend(str(prefix) + str(number) + str(suffix) for number in numbers)
    return result

def site_details(identifier):
    if not re.fullmatch(r'(mv|tv|ac)_[A-Za-z0-9]+', identifier):
        raise ValueError('资源标识不正确')
    directory, item_id = identifier.split('_', 1)
    item = dict(CATALOG.get(identifier) or metadata(directory, item_id, '视频'))
    data = site_json('/res/downurl/' + directory + '/' + item_id)
    names, groups = [], []
    # Prefer the online lines verified to connect directly on this computer.
    priority = ('非凡', '天堂', '光速', '红牛', '牛牛', '无尽', '暴风')
    def line_order(line):
        return next((i for i, name in enumerate(priority) if name in str(line.get('t', ''))), len(priority))
    for line in sorted(data.get('playlist', []), key=line_order):
        line_id = str(line['i'])
        if not re.fullmatch(r'[A-Za-z0-9]+', line_id):
            continue
        episodes = expand_episodes(line.get('list', []))
        names.append(str(line['t']))
        groups.append('#'.join(name.replace('$', '').replace('#', '') + '$' + BASE + '/stream/' +
            line_id + '/' + str(index + 1) + '/index.m3u8?_k=' + KEY for index, name in enumerate(episodes)))
    item['vod_play_from'] = '$$$'.join(names)
    item['vod_play_url'] = '$$$'.join(groups)
    item['site_resources'] = {key:value for key,value in data.items() if key != 'playlist'}
    item['site_detail_url'] = SITE + '/' + directory + '/' + item_id
    return {'code': 1, 'list': [item]}

def site_search(query):
    data = site_json('/res/search_suggest?q=' + url.quote(query) + '&num=40')
    return {'code': 1, 'pagecount': 1, 'list': [metadata(item['dir'], item['id'],
        item['title'], item.get('year', ''), '', item.get('score', '')) for item in data if item.get('dir') in ('mv', 'tv', 'ac')]}

def safe_url(address):
    parsed = url.urlsplit(address)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError('无效的网络地址')
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80))
    if any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError('不允许代理本机或内网地址')
    return address

def upstream(address, client=HTTP, headers=None, video=False):
    for _ in range(4):
        check_request()
        safe_url(address)
        host = url.urlsplit(address).hostname
        public_api=not video and any(path in url.urlsplit(address).path for path in ('/api.php/provide/','/provide/vod/'))
        if public_api and API_BACKOFF_UNTIL.get(host,0)>time.time():raise PermissionError('此公开来源正在限流冷却，已暂停新请求；其他来源和已有缓存仍可使用')
        chosen = PROXY_HTTP if video and host in MEDIA_ROUTES else client
        try:
            response = chosen.get(address, headers=headers or {}, timeout=(8 if chosen is PROXY_HTTP else 2 if video else 3, 10), stream=True, allow_redirects=False)
        except (requests.ConnectTimeout, requests.ConnectionError):
            if not video or chosen is PROXY_HTTP:
                raise
            response = PROXY_HTTP.get(address, headers=headers or {}, timeout=(8, 10), stream=True, allow_redirects=False)
            with LOCK:
                MEDIA_ROUTES[host] = True
                while len(MEDIA_ROUTES) > 64:
                    MEDIA_ROUTES.popitem(last=False)
        if response.status_code in (301, 302, 303, 307, 308):
            address = url.urljoin(address, response.headers['Location'])
            response.close()
            continue
        if public_api and response.status_code in (403,429):
            pause_public_api(address,response);response.close()
            raise PermissionError('此公开来源要求验证或限制访问，已暂停新请求至少 15 分钟；其他来源仍可使用')
        try:
            response.raise_for_status()
        except requests.HTTPError:
            response.close()
            raise
        return response
    raise ValueError('资源重定向过多')

def media_url(address, public=False):
    encoded = base64.urlsafe_b64encode(address.encode()).decode().rstrip('=')
    return BASE + ('/public-media?u=' if public else '/media?u=') + encoded + '&_k=' + KEY

def rewrite_playlist(text, address, public=False):
    lines = []
    for line in text.splitlines():
        if line and not line.startswith('#'):
            line = media_url(url.urljoin(address, line.strip()), public)
        elif line.startswith('#'):
            line = re.sub(r'URI="([^"]+)"', lambda match: 'URI="' + media_url(url.urljoin(address, match[1]), public) + '"', line)
        lines.append(line)
    return '\n'.join(lines) + '\n'

def window_handle():
    if not APP_PROCESS or APP_PROCESS.poll() is not None:
        return None
    handles = []
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    @callback_type
    def callback(handle, _):
        pid = ctypes.c_ulong()
        ctypes.windll.user32.GetWindowThreadProcessId(handle, ctypes.byref(pid))
        name = ctypes.create_unicode_buffer(100)
        ctypes.windll.user32.GetClassNameW(handle, name, 100)
        if pid.value == APP_PROCESS.pid and name.value == 'Tauri Window' and ctypes.windll.user32.IsWindowVisible(handle):
            handles.append(handle)
        return True
    ctypes.windll.user32.EnumWindows(callback, 0)
    return handles[0] if handles else None

def set_window_fullscreen(enabled):
    global FULLSCREEN_STATE
    with WINDOW_STATE_LOCK:
        handle=window_handle() or (FULLSCREEN_STATE['handle'] if FULLSCREEN_STATE else None)
        if not handle:raise ValueError('播放器窗口暂不可用')
        user=ctypes.windll.user32
        previous_dpi=user.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        try:
            if enabled and FULLSCREEN_STATE is None:
                placement=WindowPlacement();placement.length=ctypes.sizeof(placement)
                if not user.GetWindowPlacement(handle,ctypes.byref(placement)):raise ctypes.WinError()
                monitor=MonitorInfo();monitor.size=ctypes.sizeof(monitor)
                if not user.GetMonitorInfoW(user.MonitorFromWindow(handle,2),ctypes.byref(monitor)):raise ctypes.WinError()
                FULLSCREEN_STATE={'handle':handle,'placement':placement,'style':user.GetWindowLongPtrW(handle,-16)}
                user.ShowWindow(handle,9)
                user.SetWindowLongPtrW(handle,-16,user.GetWindowLongPtrW(handle,-16)&~0x00CF0000)
                rect=monitor.monitor
                if not user.SetWindowPos(handle,None,rect.left,rect.top,rect.right-rect.left,rect.bottom-rect.top,0x60):raise ctypes.WinError()
                client=wintypes.RECT();origin=wintypes.POINT();user.GetClientRect(handle,ctypes.byref(client));user.ClientToScreen(handle,ctypes.byref(origin))
                # The undecorated Tauri host retains an invisible resize border.
                width,height=rect.right-rect.left,rect.bottom-rect.top
                if 0<=width-client.right<64 and 0<=height-client.bottom<64:
                    user.SetWindowPos(handle,None,rect.left-(origin.x-rect.left),rect.top-(origin.y-rect.top),width+(width-client.right),height+(height-client.bottom),0x60)
                user.SetForegroundWindow(handle)
            elif not enabled and FULLSCREEN_STATE is not None:
                saved=FULLSCREEN_STATE
                user.SetWindowLongPtrW(handle,-16,saved['style'])
                user.SetWindowPos(handle,None,0,0,0,0,0x27)
                if not user.SetWindowPlacement(handle,ctypes.byref(saved['placement'])):raise ctypes.WinError()
                FULLSCREEN_STATE=None
            client=wintypes.RECT();user.GetClientRect(handle,ctypes.byref(client))
            user.PostMessageW(handle,0x0005,2 if user.IsZoomed(handle) else 0,(client.bottom<<16)|client.right)
            return {'fullscreen':FULLSCREEN_STATE is not None}
        finally:
            if previous_dpi:user.SetThreadDpiAwarenessContext(previous_dpi)

class Handler(BaseHTTPRequestHandler):
    def client_disconnected(self):
        try:
            return bool(select.select([self.connection], [], [], 0)[0]) and not self.connection.recv(1, socket.MSG_PEEK)
        except OSError:return True
    def log_message(self, *args):
        pass
    def do_OPTIONS(self):
        if self.headers.get('Origin') != 'http://tauri.localhost':
            self.json_reply({'error': 'Forbidden origin'}, 403);return
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', 'http://tauri.localhost')
        self.send_header('Access-Control-Allow-Headers', 'X-RoseTV-Key, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Max-Age', '600')
        self.end_headers()
    def do_POST(self):
        global SITE_HTTP, SITE
        if self.headers.get('Origin') not in (None, 'http://tauri.localhost') or not secrets.compare_digest(self.headers.get('X-RoseTV-Key',''),KEY):
            self.json_reply({'error': 'Unauthorized'},401);return
        try:
            if self.path == '/account/login':
                self.json_reply(site_session.start_login(SITE))
            elif self.path == '/account/visit':
                os.startfile(SITE+'/')
                self.json_reply({'opened':True,'message':'已在默认浏览器打开网站；该浏览器的账号不会自动连接到 RoseTV'})
            elif self.path == '/provider/save':
                size=int(self.headers.get('Content-Length',0))
                if not 0<size<=16384:raise ValueError('地址设置过长')
                self.json_reply(save_provider_settings(json.loads(self.rfile.read(size))))
            elif self.path == '/provider/refresh':
                self.json_reply(refresh_provider_addresses())
            elif self.path == '/account/save':
                if not site_session.login_status()['loginWindowOpen']:
                    raise ValueError('请先点击“登录 / 更换账号”并完成网站登录')
                site_session.save_browser_session(site_session.LOGIN_PORT, validate=True)
                with LOCK:
                    CONFIG['siteSessionAuthorized']=True;CONFIG['siteOrigin']=site_session.LOGIN_ORIGIN
                    CONFIG_FILE.write_text(json.dumps(CONFIG),encoding='utf-8')
                    SITE=site_session.LOGIN_ORIGIN
                    CACHE.clear()
                    previous=SITE_HTTP;SITE_HTTP=None
                if previous:previous.close()
                site_session.close_login()
                self.json_reply({'saved':True,'message':'登录状态已加密保存，教父资源已启用'})
            else:self.json_reply({'error':'Not found'},404)
        except (ValueError,StopIteration) as error:
            self.json_reply({'error':str(error) or '请完成网站登录后重试'},400)
        except Exception:
            self.json_reply({'error':'暂时无法完成账号操作，请检查登录窗口后重试；原登录状态已保留'},502)
    def json_reply(self, value, status=200):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Access-Control-Allow-Origin', 'http://tauri.localhost')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)
    def relay(self, address, client=HTTP, video=False):
        request_headers = {'Referer': (url.urlsplit(address).scheme + '://' + url.urlsplit(address).netloc + '/') if client is HTTP else SITE + '/'}
        request_headers['User-Agent'] = client.headers.get('User-Agent', 'Mozilla/5.0')
        request_headers['Accept-Encoding'] = 'identity'
        if self.headers.get('Range'):
            request_headers['Range'] = self.headers['Range']
        for name in ('If-Range','If-None-Match','If-Modified-Since'):
            if self.headers.get(name):request_headers[name]=self.headers[name]
        with upstream(address, client, request_headers, video=video) as response:
            content_type = response.headers.get('Content-Type', 'application/octet-stream')
            if response.status_code==304:
                self.send_response(304)
                for name in ('ETag','Last-Modified','Cache-Control'):
                    if name in response.headers:self.send_header(name,response.headers[name])
                self.send_header('Access-Control-Allow-Origin','http://tauri.localhost');self.end_headers();return
            # Deliver stream headers and bytes promptly; HLS can decode before EOF.
            iterator = response.iter_content(16384)
            first = next(iterator, b'')
            if first.lstrip().startswith(b'#EXTM3U'):
                playlist = read_limited(chain([first], iterator), 512 * 1024)
                body = rewrite_playlist(playlist.decode('utf-8-sig'), response.url, client is HTTP).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.apple.mpegurl')
                self.send_header('Content-Length', str(len(body)))
            else:
                body = None
                self.send_response(response.status_code)
                self.send_header('Content-Type', content_type)
                for name in ('Content-Length', 'Content-Range', 'Accept-Ranges'):
                    if name == 'Content-Length' and response.headers.get('Content-Encoding', 'identity') != 'identity':
                        continue
                    if name in response.headers:
                        self.send_header(name, response.headers[name])
            self.send_header('Access-Control-Allow-Origin', 'http://tauri.localhost')
            if body is None:
                for name in ('ETag','Last-Modified'):
                    if name in response.headers:self.send_header(name,response.headers[name])
            cacheable = content_type.startswith('image/') or (body is not None and (b'#EXT-X-ENDLIST' in body or b'#EXT-X-MEDIA-SEQUENCE' not in body))
            self.send_header('Cache-Control', 'private, max-age=' + ('3600' if content_type.startswith('image/') else '30') if cacheable else 'no-store')
            self.end_headers()
            if body is not None:
                self.wfile.write(body)
            else:
                self.wfile.write(first)
                for chunk in iterator:
                    self.wfile.write(chunk)
    def do_GET(self):
        origin = self.headers.get('Origin')
        if origin and origin not in ('http://tauri.localhost', 'https://tauri.localhost'):
            self.json_reply({'error': 'Forbidden origin'}, 403)
            return
        parsed = url.urlsplit(self.path)
        query = url.parse_qs(parsed.query)
        provided = self.headers.get('X-RoseTV-Key') or query.get('_k', [''])[0]
        if not secrets.compare_digest(provided, KEY):
            self.json_reply({'error': 'Unauthorized'}, 401)
            return
        REQUEST_CONTEXT.cancelled = self.client_disconnected
        try:
            path = parsed.path
            if path == '/cache-location':
                self.json_reply(cache_location_status());return
            if path == '/account/status':
                self.json_reply({**site_session.login_status(SITE),'enabled':site_enabled()});return
            if path == '/subject':
                self.json_reply(subject_info(query['id'][0]) if query.get('id') else find_subject_info(query.get('title',[''])[0],query.get('year',[''])[0]));return
            if path == '/suggest':
                self.json_reply(search_suggestions(query.get('q',[''])[0]));return
            if path == '/provider':
                self.json_reply(provider_settings());return
            if path == '/cache-location/choose':
                self.json_reply(choose_cache_directory());return
            if path == '/health':
                handle = window_handle()
                if handle:
                    ctypes.windll.user32.SetWindowTextW(handle, 'RoseTV')
                self.json_reply({'ok': True, 'site': site_enabled(), 'maximized': bool(handle and ctypes.windll.user32.IsZoomed(handle)),
                    'providerOrigin': SITE, 'providerBackups': [origin for origin in PROVIDER_ORIGINS if origin != SITE],
                    'siteCooldownSeconds': max(0,int(SITE_TIMING['blockedUntil']-time.monotonic()))})
            elif path in ('/assets/rosetv.js','/assets/rosetv.css'):
                asset = ROOT / 'source' / 'public' / ('js' if path.endswith('.js') else 'css') / path.rsplit('/', 1)[1]
                body = asset.read_bytes()
                self.send_response(200)
                self.send_header('Content-Type', 'text/javascript; charset=utf-8' if path.endswith('.js') else 'text/css; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(body)
            elif path == '/library':
                self.json_reply(library(query.get('kind', ['mv'])[0], int(query.get('page', ['1'])[0]),
                    int(query.get('limit', ['16'])[0]), {key: query.get(key, [''])[0] for key in ('genre','genreMode','year','region','lang','rating','sort','quality','status','cursor')},
                    details=query.get('details',['0'])[0]=='1',background=query.get('background',['0'])[0]=='1' or query.get('prefetch',['0'])[0]=='1',rich=query.get('rich',['0'])[0]=='1'))
            elif path == '/storage':
                save_public_cache()
                self.json_reply(storage_status())
            elif path == '/clear-cache':
                with LOCK: CACHE.clear();PUBLIC_RECORDS.clear()
                PUBLIC_CACHE_FILE.unlink(missing_ok=True)
                body = b'{"ok":true}'
                self.send_response(200)
                self.send_header('Clear-Site-Data', '"cache"')
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', 'http://tauri.localhost')
                self.send_header('Access-Control-Allow-Credentials', 'true')
                self.end_headers(); self.wfile.write(body)
            elif path.startswith('/window/'):
                if path=='/window/fullscreen':
                    value=query.get('enabled',[''])[0]
                    if value not in ('0','1'):raise ValueError('全屏状态不正确')
                    self.json_reply(set_window_fullscreen(value=='1'));return
                handle = window_handle()
                action = path.rsplit('/', 1)[-1]
                if handle:
                    if action == 'minimize':
                        ctypes.windll.user32.ShowWindow(handle, 6)
                    elif action == 'maximize':
                        ctypes.windll.user32.ShowWindow(handle, 9 if ctypes.windll.user32.IsZoomed(handle) else 3)
                    elif action == 'focus':
                        if ctypes.windll.user32.IsIconic(handle):ctypes.windll.user32.ShowWindow(handle, 9)
                        ctypes.windll.user32.SetForegroundWindow(handle)
                    elif action == 'drag':
                        ctypes.windll.user32.PostMessageW(handle, 0x00A1, 2, 0)
                    elif action == 'close':
                        ctypes.windll.user32.PostMessageW(handle, 0x0010, 0, 0)
                        def finish():
                            try:
                                APP_PROCESS.wait(timeout=2)
                            except subprocess.TimeoutExpired:
                                APP_PROCESS.terminate()
                        threading.Thread(target=finish, daemon=True).start()
                self.json_reply({'ok': bool(handle), 'maximized': bool(handle and ctypes.windll.user32.IsZoomed(handle))})
            elif path == '/home':
                limit = int(query.get('limit', ['12'])[0])
                if not 1 <= limit <= 24:
                    raise ValueError('展示数量不正确')
                self.json_reply(recommendations(limit))
            elif path == '/catalog':
                self.json_reply(site_catalog(query.get('kind', ['mv'])[0], int(query.get('page', ['1'])[0]),
                    int(query['limit'][0]) if 'limit' in query else None, int(query['cursor'][0]) if 'cursor' in query else None))
            elif path == '/api.php/provide/vod/':
                self.json_reply(site_details(query['ids'][0]) if query.get('ids') else site_search(query.get('wd', [''])[0]))
            elif path.startswith('/cover/'):
                _, _, directory, identifier = path.split('/')
                if directory not in ('mv', 'tv', 'ac') or not re.fullmatch(r'[A-Za-z0-9]+', identifier):
                    raise ValueError('封面标识不正确')
                size = query.get('size', ['384'])[0]
                if size not in ('256', '384'):
                    raise ValueError('封面尺寸不正确')
                self.relay('https://s.tutu.pm/img/' + directory + '/' + identifier + '/' + size + '.webp', site_client())
            elif path.startswith('/stream/'):
                parts = path.split('/')
                line_id, episode = parts[2], parts[3]
                if not re.fullmatch(r'[A-Za-z0-9]+', line_id) or not episode.isdigit():
                    raise ValueError('播放标识不正确')
                self.relay(site_json('/res/py/' + line_id + '/' + episode)['url'], site_client(), video=True)
            elif path in ('/media', '/public-media'):
                encoded = query.get('u', [''])[0]
                address = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)).decode()
                image=bool(re.search(r'\.(?:jpe?g|png|webp|gif|avif)(?:$|\?)',address,re.I))
                self.relay(address, HTTP if path == '/public-media' else site_client(), video=not image)
            elif path == '/http':
                address = query.get('url', [''])[0]
                def read_api():
                    check_request()
                    with upstream(address) as response:
                        body = read_limited(response.iter_content(65536), 8 * 1024 * 1024)
                        if not body.lstrip().startswith((b'{',b'[')) and re.search(rb'captcha|challenge-platform|Just a moment',body[:65536],re.I):
                            pause_public_api(address,response);raise PermissionError('此公开来源要求网站验证，已暂停新请求；请使用其他来源')
                        return body, response.headers.get('Content-Type', 'application/json')
                body, content_type = cached('api:' + address, read_api)
                self.send_response(200)
                self.send_header('Content-Type', content_type)
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', 'http://tauri.localhost')
                self.end_headers()
                self.wfile.write(body)
            else:
                self.json_reply({'error': 'Not found'}, 404)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except LocalRequestBudget as error:
            self.json_reply({'error':str(error),'code':'local_budget','provider':error.provider,'retryAfterSeconds':error.retry_after},429)
        except PermissionError as error:
            self.json_reply({'error': str(error)}, 403)
        except requests.exceptions.SSLError:
            self.json_reply({'error':'上游 HTTPS 证书或 TLS 连接失败'},502)
        except requests.Timeout:
            self.json_reply({'error':'上游连接或读取超时，请稍后再试'},504)
        except requests.ConnectionError as error:
            self.json_reply({'error':'上游域名解析失败' if 'getaddrinfo' in str(error) or 'NameResolutionError' in str(error) else '上游连接失败或被重置'},502)
        except requests.HTTPError as error:
            status=error.response.status_code if error.response is not None else 502
            self.json_reply({'error':'上游 HTTP '+str(status)+('：拒绝访问或要求网站验证' if status in (403,429) else '')},502)
        except ValueError as error:
            self.json_reply({'error':str(error)},400)
        except Exception:
            self.json_reply({'error': '该资源暂时不可用，请重试或换源'}, 502)

def main():
    global APP_PROCESS
    if '--serve-only' not in sys.argv:
        try:
            response = HTTP.get(BASE + '/health', headers={'X-RoseTV-Key': KEY}, timeout=1)
            if response.ok:
                HTTP.get(BASE + '/window/focus', headers={'X-RoseTV-Key': KEY}, timeout=1)
                return
        except requests.RequestException:
            pass
    activate_cache_directory()
    load_public_cache()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    if '--serve-only' in sys.argv:
        server.serve_forever()
        return
    threading.Thread(target=server.serve_forever, daemon=True).start()
    environment = os.environ.copy()
    environment['WEBVIEW2_USER_DATA_FOLDER'] = str(browser_profile_path().parent)
    environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] = '--disk-cache-size=33554432'
    if CONFIG.get('cacheDirectory'):
        environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] += ' --disk-cache-dir="'+str(network_cache_path())+'"'
    if '--test' in sys.argv:
        environment['WEBVIEW2_USER_DATA_FOLDER'] = str(ROOT / 'tools' / 'app-test-profile')
    if '--test' in sys.argv or '--inspect' in sys.argv:
        environment['WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'] += ' --remote-debugging-port=9227 --remote-debugging-address=127.0.0.1'
    APP_PROCESS = subprocess.Popen([str(APP)], cwd=APP.parent, env=environment)
    threading.Thread(target=checkpoint_cache,daemon=True).start()
    if '--test' in sys.argv or '--inspect' in sys.argv:
        print('RoseTV preview process:', APP_PROCESS.pid, flush=True)
    try:
        APP_PROCESS.wait()
    finally:
        save_public_cache()
        save_request_state()
        server.shutdown()
        HTTP.close()
        PROXY_HTTP.close()
        if SITE_HTTP:
            SITE_HTTP.close()

if __name__ == '__main__':
    main()
