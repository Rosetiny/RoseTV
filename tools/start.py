"""Prepare this user's native assets once, then start the local desktop app."""
import ctypes
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent


def prepare(bridge):
    import build_local
    target=ROOT/'App/rosetv-native.exe'
    manifest_file=ROOT/'build/frontend-manifest.json'
    try:
        manifest=json.loads(manifest_file.read_text(encoding='utf-8'))
        if manifest.get('frontendSignature')==build_local.frontend_signature(bridge.KEY) and target.is_file():
            if hashlib.sha256(target.read_bytes()).hexdigest()==manifest['updatedSHA256']:return False
    except (OSError,ValueError,KeyError):pass
    build_local.build(compile_launcher=False)
    target.parent.mkdir(exist_ok=True)
    temporary=target.with_suffix('.tmp')
    shutil.copyfile(ROOT/'build/rosetv-native.exe',temporary)
    os.replace(temporary,target)
    return True


def main():
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateMutexW.argtypes=[ctypes.c_void_p,ctypes.c_bool,ctypes.c_wchar_p]
    kernel.CreateMutexW.restype=ctypes.c_void_p
    kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    kernel.ReleaseMutex.argtypes=[ctypes.c_void_p]
    handle=kernel.CreateMutexW(None,True,'Local\\RoseTV.Startup.34771')
    if not handle:raise ctypes.WinError(ctypes.get_last_error())
    already_running=ctypes.get_last_error()==183
    try:
        import rosetv_bridge as bridge
        for _ in range(40 if already_running else 1):
            try:
                response=bridge.HTTP.get(bridge.BASE+'/health',headers={'X-RoseTV-Key':bridge.KEY},timeout=.5)
                if response.ok:
                    bridge.HTTP.get(bridge.BASE+'/window/focus',headers={'X-RoseTV-Key':bridge.KEY},timeout=1)
                    return
                if response.status_code==401:raise RuntimeError('RoseTV is running from another folder. Close it before starting this copy.')
            except bridge.requests.RequestException:pass
            if already_running:time.sleep(.25)
        if already_running:return
        prepare(bridge)
        if '--prepare-only' in sys.argv:return
        bridge.main()
    finally:
        if not already_running:kernel.ReleaseMutex(handle)
        kernel.CloseHandle(handle)


if __name__=='__main__':
    try:main()
    except Exception as error:
        # Keep account values out of startup diagnostics.
        message='RoseTV could not start.\n\n'+str(error)+'\n\nExtract the complete project into a writable folder and try again.'
        ctypes.windll.user32.MessageBoxW(None,message,'RoseTV',16)
        raise SystemExit(1)
