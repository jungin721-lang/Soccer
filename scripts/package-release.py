"""Create static and server-source release ZIPs without personal workspace data."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from hashlib import sha256
import json
import subprocess

ROOT = Path(__file__).resolve().parents[1]
subprocess.run(['node', 'scripts/export-standalone.js'], cwd=ROOT, check=True)
ARTIFACTS = ROOT / '.artifacts'
manifest = {}

def archive(name, base, files, prefix):
    target = ARTIFACTS / name
    with ZipFile(target, 'w', compression=ZIP_DEFLATED) as bundle:
        for file in sorted(files):
            bundle.write(file, str(Path(prefix) / file.relative_to(base)))
    data = target.read_bytes()
    manifest[name] = {'bytes': len(data), 'sha256': sha256(data).hexdigest()}
    print(name, manifest[name])

site_files = [ROOT / '.artifacts/site/index.html', ROOT / '.artifacts/site/.nojekyll']
for name in ['NEXT-XI-mobile-site.zip', 'NEXT-XI-original-video.zip']:
    archive(name, ARTIFACTS / 'site', site_files, 'NEXT-XI-site')

source_files = [ROOT / file for file in ['.gitignore', 'package.json', 'README.md', 'server.js', 'netlify.toml']]
for folder in ['public', 'lib', 'netlify', 'scripts', 'tests', 'docs']:
    source_files.extend(file for file in (ROOT / folder).rglob('*') if file.is_file() and '__pycache__' not in file.parts and file.suffix in ['.js', '.mjs', '.py', '.svg', '.css', '.html', '.md'])
archive('NEXT-XI-analysis-server.zip', ROOT, source_files, 'NEXT-XI-source')
(ARTIFACTS / 'release-manifest.json').write_text(json.dumps(manifest, indent=2), encoding='utf8')
