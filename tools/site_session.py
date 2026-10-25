"""Keep the requested site's login session encrypted for this Windows user."""
import ctypes
import atexit
import json
import os
import subprocess
import threading
import time
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SITE = 'https://www.xn--wcv59z.com'
SESSION_FILE = ROOT / 'provider-session.bin'
LOGIN_PORT = 9231
LOGIN_ORIGIN = SITE
LOGIN_PROCESS = None
LOGIN_PROFILE = None
LOGIN_LOCK = threading.Lock()
LOGIN_DATA = ROOT / 'provider-browser'

def login_browser():
    """Prefer the registered Chromium default; use a separate profile for the app."""
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER,r'Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice') as key:
            program=winreg.QueryValueEx(key,'ProgId')[0]
        with winreg.OpenKey(winreg.HKEY_CLASSES_ROOT,program+r'\shell\open\command') as key:
            command=winreg.QueryValueEx(key,None)[0]
        executable=command.split('"')[1] if command.startswith('"') else command.split(' ')[0]
        path=Path(os.path.expandvars(executable))
        if path.name.lower() in ('chrome.exe','msedge.exe','brave.exe','vivaldi.exe') and path.is_file():return path
    except (OSError,IndexError):pass
    candidates=[Path(os.environ.get(key,''))/'Microsoft/Edge/Application/msedge.exe' for key in ('ProgramFiles(x86)','ProgramFiles','LOCALAPPDATA')]
    return next((path for path in candidates if path.is_file()),None)

def close_login():
    if LOGIN_PROCESS and LOGIN_PROCESS.poll() is None:
        LOGIN_PROCESS.terminate()
        try:LOGIN_PROCESS.wait(timeout=5)
        except subprocess.TimeoutExpired:pass

atexit.register(close_login)

def start_login(origin=SITE):
    """Use the site's own login form, including its normal verification steps."""
    global LOGIN_PROCESS, LOGIN_PROFILE, LOGIN_ORIGIN
    with LOGIN_LOCK:
        if LOGIN_PROCESS and LOGIN_PROCESS.poll() is None:
            return {'opened': True, 'message': '登录窗口已经打开，请在该窗口完成登录'}
        browser=login_browser()
        if not browser:
            raise ValueError('未找到 Microsoft Edge，无法打开网站登录窗口')
        profile = str(LOGIN_DATA if browser.name.lower()=='msedge.exe' else LOGIN_DATA/browser.stem)
        LOGIN_PROFILE = profile
        LOGIN_ORIGIN = origin
        LOGIN_PROCESS = subprocess.Popen([str(browser), '--user-data-dir='+profile,
            '--remote-debugging-port='+str(LOGIN_PORT), '--remote-debugging-address=127.0.0.1',
            '--no-first-run','--disk-cache-size=8388608', '--disable-features=msEdgePasswordManager', '--new-window', 'about:blank'])
        try:restore_browser_login(origin)
        except Exception:
            subprocess.Popen([str(browser),'--user-data-dir='+profile,origin+'/'])
        return {'opened': True, 'message': '已用 '+browser.stem+' 打开 RoseTV 专用登录窗口，复用该域名登录状态；请正常完成网站验证后保存。有效期由网站决定。'}

def login_status(origin=SITE):
    return {'saved':has_session(origin),'loginWindowOpen':bool(LOGIN_PROCESS and LOGIN_PROCESS.poll() is None),
        'loginOrigin':LOGIN_ORIGIN,'origin':origin}

class Blob(ctypes.Structure):
    _fields_ = [('size', ctypes.c_ulong), ('data', ctypes.POINTER(ctypes.c_ubyte))]

def crypt(data, decrypt=False):
    buffer = ctypes.create_string_buffer(data)
    source = Blob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    output = Blob()
    if decrypt:
        ok = ctypes.windll.crypt32.CryptUnprotectData(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output))
    else:
        ok = ctypes.windll.crypt32.CryptProtectData(ctypes.byref(source), 'RoseTV provider session', None, None, None, 1, ctypes.byref(output))
    if not ok:
        raise ctypes.WinError()
    try:
        return ctypes.string_at(output.data, output.size)
    finally:
        ctypes.windll.kernel32.LocalFree(output.data)

def saved_sessions():
    if not SESSION_FILE.exists():return {}
    data=json.loads(crypt(SESSION_FILE.read_bytes(),decrypt=True))
    return data.get('sessions',{}) if 'sessions' in data else {data.get('origin',SITE):data}

def load_session(origin=SITE):
    data=saved_sessions().get(origin)
    if not data:raise ValueError('当前网站域名尚未保存登录状态，请连接账号')
    return data

def has_session(origin=SITE):
    try:return bool(load_session(origin).get('cookies'))
    except (OSError,ValueError):return False

def reusable_auth_cookies(data,origin):
    if data.get('origin',SITE)!=origin:return []
    host=urllib.parse.urlsplit(origin).hostname
    result=[]
    for cookie in data.get('cookies',[]):
        domain=cookie.get('domain','').lstrip('.')
        if cookie.get('name')!='app_auth' or not domain or not (host==domain or host.endswith('.'+domain)):continue
        if cookie.get('expires',-1)>0 and cookie['expires']<=time.time():continue
        result.append({key:value for key,value in cookie.items() if key in ('name','value','domain','path','secure','httpOnly','sameSite','expires')})
    return result

def restore_browser_login(origin):
    """Restore account cookies only. Never transplant browser verification tokens."""
    import requests,websocket
    http=requests.Session();http.trust_env=False
    pages=[]
    for _ in range(16):
        try:
            pages=http.get('http://127.0.0.1:'+str(LOGIN_PORT)+'/json/list',timeout=.5).json()
            if pages:break
        except requests.RequestException:pass
        time.sleep(.2)
    tab=next(page for page in pages if page.get('type')=='page' and page.get('url')=='about:blank')
    socket=websocket.create_connection(tab['webSocketDebuggerUrl'],timeout=5,suppress_origin=True);sequence=0
    def call(method,params):
        nonlocal sequence
        sequence+=1;socket.send(json.dumps({'id':sequence,'method':method,'params':params}))
        while True:
            response=json.loads(socket.recv())
            if response.get('id')==sequence:return response.get('result',{})
    try:
        existing=call('Network.getCookies',{'urls':[origin+'/']}).get('cookies',[])
        if not any(cookie.get('name')=='app_auth' for cookie in existing) and has_session(origin):
            cookies=reusable_auth_cookies(load_session(origin),origin)
            if cookies:call('Network.setCookies',{'cookies':cookies})
        call('Page.navigate',{'url':origin+'/'})
    finally:socket.close();http.close()

def save_browser_session(port=9230, validate=False):
    import requests
    import websocket
    http = requests.Session()
    http.trust_env = False
    tabs = http.get('http://127.0.0.1:' + str(port) + '/json/list', timeout=3).json()
    origin=LOGIN_ORIGIN if port==LOGIN_PORT else SITE
    tab = next((t for t in tabs if t.get('type') == 'page' and t.get('url', '').startswith(origin + '/')), None)
    if not tab:
        raise ValueError('请先在教父资源网站完成登录')
    socket = websocket.create_connection(tab['webSocketDebuggerUrl'], timeout=10, suppress_origin=True)
    sequence = 0
    def call(method, params):
        nonlocal sequence
        sequence += 1
        socket.send(json.dumps({'id': sequence, 'method': method, 'params': params}))
        while True:
            result = json.loads(socket.recv())
            if result.get('id') == sequence:
                return result['result']
    try:
        if validate:
            check = call('Runtime.evaluate', {'expression': "fetch('/res/search_suggest?q='+encodeURIComponent('西游记')+'&num=1').then(async r=>({ok:r.ok,data:await r.json()})).catch(()=>({ok:false}))", 'returnByValue': True, 'awaitPromise': True})
            value = check.get('result', {}).get('value', {})
            if not value.get('ok') or not isinstance(value.get('data'), list) or not value['data']:
                raise ValueError('登录尚未完成或网站正在验证，请在网站完成后再保存；原登录状态已保留')
        cookies = call('Network.getCookies', {'urls': [origin + '/']})['cookies']
        if not cookies:
            raise ValueError('尚未取得网站登录状态，请先登录')
        agent = call('Runtime.evaluate', {'expression': 'navigator.userAgent', 'returnByValue': True})['result']['value']
        with LOGIN_LOCK:
            sessions=saved_sessions();sessions[origin]={'cookies':cookies,'userAgent':agent,'origin':origin,'savedAt':time.time()}
            pending=SESSION_FILE.with_suffix('.tmp')
            pending.write_bytes(crypt(json.dumps({'sessions':sessions}).encode()))
            pending.replace(SESSION_FILE)
        return len(cookies)
    finally:
        socket.close()

if __name__ == '__main__':
    print('Encrypted site session saved; cookie count:', save_browser_session())
    import requests
    data = load_session()
    http = requests.Session()
    http.trust_env = False
    http.proxies = {'http': 'http://127.0.0.1:7890', 'https': 'http://127.0.0.1:7890'}
    http.headers.update({'User-Agent': data['userAgent'], 'Referer': SITE + '/'})
    for cookie in data['cookies']:
        http.cookies.set(cookie['name'], cookie['value'], domain=cookie['domain'], path=cookie['path'])
    response = http.get(SITE + '/res/search_suggest', params={'q': '西游记', 'num': 4}, timeout=12)
    result = response.json()
    print('Authenticated API check:', response.status_code, 'results:', len(result) if isinstance(result, list) else result.get('code'))
