"""Build the private Python runtime bundle from official Python and PyPI wheels."""
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path
import requests

ROOT=Path(__file__).resolve().parent.parent
VERSION='3.13.17'
URL='https://www.python.org/ftp/python/'+VERSION+'/python-'+VERSION+'-embed-amd64.zip'
SHA256='9e35319bffedab8b36ad44d8f377cb4f1733bcec257a0b6d04d94f01486ddb38'


def extract(archive,destination):
    with zipfile.ZipFile(archive) as source:
        for name in source.namelist():
            target=(destination/name).resolve()
            if destination.resolve() not in target.parents:raise ValueError('Unsafe archive member')
        source.extractall(destination)


def main():
    work=ROOT/'build/runtime-package';work.mkdir(parents=True,exist_ok=True)
    download=work/('python-'+VERSION+'.zip')
    if not download.exists():
        response=requests.get(URL,timeout=60);response.raise_for_status();download.write_bytes(response.content)
    if hashlib.sha256(download.read_bytes()).hexdigest()!=SHA256:raise ValueError('Python download hash mismatch')
    wheels=work/'wheels';wheels.mkdir(exist_ok=True)
    subprocess.run([sys.executable,'-m','pip','download','--only-binary=:all:','--platform','win_amd64',
        '--python-version','313','--implementation','cp','--abi','cp313','-r',str(ROOT/'requirements.txt'),'-d',str(wheels)],check=True)
    stage=work/'python';stage.mkdir(exist_ok=True);extract(download,stage)
    packages=stage/'Lib/site-packages';packages.mkdir(parents=True,exist_ok=True)
    records=[]
    for wheel in sorted(wheels.glob('*.whl')):
        extract(wheel,packages)
        records.append({'wheel':wheel.name,'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest()})
    (stage/'python313._pth').write_text('python313.zip\n.\nLib/site-packages\n../..\n../../tools\nimport site\n',encoding='utf-8')
    runtime=ROOT/'runtime';runtime.mkdir(exist_ok=True)
    archive=runtime/'python-runtime.zip'
    with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as output:
        for path in sorted(stage.rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts:output.write(path,path.relative_to(stage).as_posix())
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    (runtime/'python-runtime.sha256').write_text(digest+'\n',encoding='ascii')
    (runtime/'manifest.json').write_text(json.dumps({'python':VERSION,'platform':'win_amd64','pythonSource':URL,
        'pythonArchiveSHA256':SHA256,'bundleSHA256':digest,'wheels':records},indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'bundle':str(archive.relative_to(ROOT)),'bytes':archive.stat().st_size,'sha256':digest}))


if __name__=='__main__':main()
