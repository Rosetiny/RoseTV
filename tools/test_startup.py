"""Offline checks for automatic preparation and reuse of native assets."""
import hashlib,json,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import build_local
import start


class StartupChecks(unittest.TestCase):
    def test_embedded_changes_invalidate_signature_but_external_assets_do_not(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);scripts=root/'source/public/js';scripts.mkdir(parents=True)
            (scripts/'config.js').write_text('first');(scripts/'rosetv.js').write_text('external')
            with patch.object(build_local,'ROOT',root):
                before=build_local.frontend_signature('key-A')
                (scripts/'rosetv.js').write_text('changed externally')
                self.assertEqual(before,build_local.frontend_signature('key-A'))
                self.assertNotEqual(before,build_local.frontend_signature('key-B'))
                (scripts/'config.js').write_text('changed embedded')
                self.assertNotEqual(before,build_local.frontend_signature('key-A'))

    def test_prepared_native_is_reused_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'App').mkdir();(root/'build').mkdir()
            body=b'prepared-native';(root/'App/rosetv-native.exe').write_bytes(body)
            (root/'build/frontend-manifest.json').write_text(json.dumps({'frontendSignature':'same','updatedSHA256':hashlib.sha256(body).hexdigest()}))
            with patch.object(start,'ROOT',root),patch.object(build_local,'frontend_signature',return_value='same'),patch.object(build_local,'build') as rebuild:
                self.assertFalse(start.prepare(SimpleNamespace(KEY='test')));rebuild.assert_not_called()

    def test_missing_or_changed_native_is_prepared_without_requiring_a_compiler(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'build').mkdir();(root/'build/rosetv-native.exe').write_bytes(b'new-native')
            with patch.object(start,'ROOT',root),patch.object(build_local,'build') as rebuild:
                self.assertTrue(start.prepare(SimpleNamespace(KEY='test')))
                rebuild.assert_called_once_with(compile_launcher=False)
                self.assertEqual((root/'App/rosetv-native.exe').read_bytes(),b'new-native')


if __name__=='__main__':unittest.main()
