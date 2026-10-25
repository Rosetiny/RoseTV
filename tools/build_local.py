"""Update verified embedded frontend assets; retain the original native program."""
import hashlib
import json
import struct
import os
import subprocess
import sys
from pathlib import Path

import brotli

ROOT = Path(__file__).resolve().parent.parent
BACKUP = ROOT / 'backups' / '20261022-performance'
ORIGINAL_HASH = '52980511d53d34cedb723afe2fec0a73f9bf615928f4baffc93612d58c821f86'

def frontend_signature(key):
    digest=hashlib.sha256(key.encode())
    digest.update(Path(__file__).read_bytes())
    for path in sorted((ROOT/'source/public/js').glob('*.js')):
        if path.name!='rosetv.js':digest.update(path.name.encode());digest.update(path.read_bytes())
    return digest.hexdigest()


def build(compile_launcher=True):
    original = (BACKUP / 'app.exe').read_bytes() if (BACKUP/'app.exe').is_file() else brotli.decompress((ROOT/'vendor/rosetv-native-base.br').read_bytes())
    if hashlib.sha256(original).hexdigest() != ORIGINAL_HASH:
        raise ValueError('The original executable does not match the verified backup')
    result = bytearray(original)
    pe = struct.unpack_from('<I', original, 0x3c)[0]
    optional = pe + 24
    image_base = struct.unpack_from('<Q', original, optional + 24)[0]
    section_count = struct.unpack_from('<H', original, pe + 6)[0]
    sections = optional + struct.unpack_from('<H', original, pe + 20)[0]
    def virtual_address(position):
        for index in range(section_count):
            virtual, size, raw = struct.unpack_from('<III', original, sections + 40 * index + 12)
            if raw <= position < raw + size:
                return image_base + virtual + position - raw
        raise ValueError('Asset is outside the executable data sections')
    from rosetv_bridge import KEY
    key=KEY
    changes = []
    for path in sorted((ROOT/'source/public/js').glob('*.js')):
        name=path.name
        marker = ('js/' + name).encode()
        position = original.find(marker)
        if position < 0:
            if name=='rosetv.js':continue  # Intentionally loaded by the bridge bootstrap.
            raise ValueError('Missing embedded asset: ' + name)
        start = position + len(marker)
        decoder = brotli.Decompressor()
        expanded = bytearray()
        for end in range(start, min(start + 100000, len(original))):
            expanded.extend(decoder.process(original[end:end + 1]))
            if decoder.is_finished():
                break
        else:
            raise ValueError('Embedded asset has no stream terminator')
        if (BACKUP/name).is_file() and bytes(expanded) != (BACKUP/name).read_bytes():
            raise ValueError('Embedded source differs from backup: ' + name)
        old_length = end + 1 - start
        source = (ROOT / 'source' / 'public' / 'js' / name).read_text(encoding='utf-8')
        source = source.replace('__ROSETV_BRIDGE_KEY__', key).encode()
        if source==bytes(expanded):continue
        compressed = brotli.compress(source, quality=11)
        if len(compressed) > old_length:
            raise ValueError('Updated asset does not fit its original slot: '+name)
        slice_marker = struct.pack('<QQ', virtual_address(start), old_length)
        if original.count(slice_marker) != 1:
            raise ValueError('Asset slice metadata is not unique: ' + name)
        metadata = original.index(slice_marker)
        result[start:start + len(compressed)] = compressed
        struct.pack_into('<Q', result, metadata + 8, len(compressed))
        assert brotli.decompress(bytes(result[start:start + len(compressed)])) == source
        changes.append({'file': name, 'offset': start, 'originalSize': old_length,
            'updatedSize': len(compressed), 'sliceLengthOffset': metadata + 8,
            'sourceSHA256': hashlib.sha256(source).hexdigest()})
    assert len(result) == len(original)
    allowed = bytearray(len(original))
    for item in changes:
        allowed[item['offset']:item['offset'] + item['updatedSize']] = b'\1' * item['updatedSize']
        allowed[item['sliceLengthOffset']:item['sliceLengthOffset'] + 8] = b'\1' * 8
    assert all(a == b or permitted for a, b, permitted in zip(original, result, allowed))
    build_directory = ROOT / 'build'
    build_directory.mkdir(exist_ok=True)
    (build_directory / 'rosetv-native.exe').write_bytes(result)
    (build_directory / 'frontend-manifest.json').write_text(json.dumps({
        'originalSHA256': ORIGINAL_HASH, 'updatedSHA256': hashlib.sha256(result).hexdigest(),
        'frontendSignature': frontend_signature(key),
        'nativeCodeUnchanged': True, 'assets': changes,
        'localAssets': [{'file': str(path.relative_to(ROOT)), 'SHA256': hashlib.sha256(path.read_bytes()).hexdigest()}
            for path in [ROOT/'source/public/js/rosetv.js',ROOT/'source/public/css/rosetv.css']]}, indent=2), encoding='utf-8')
    if compile_launcher:
        compiler=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        subprocess.run([str(compiler),'/nologo','/target:winexe','/reference:System.Windows.Forms.dll',
            '/reference:System.IO.Compression.FileSystem.dll','/reference:System.IO.Compression.dll',
            '/out:'+str(build_directory/'RoseTV.exe'),str(ROOT/'tools/Launcher.cs')],check=True)
    local_python=Path(sys.executable).with_name('pythonw.exe')
    if local_python.is_file():(ROOT/'tools/python-path.txt').write_text(str(local_python),encoding='utf-8')
    print('Verified frontend assets updated:', len(changes))

if __name__ == '__main__':
    build()
