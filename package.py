from pathlib import Path
import json
import os
import subprocess
from tempfile import TemporaryDirectory
from zipfile import ZipFile, ZIP_DEFLATED
from xml.sax.saxutils import escape

root=Path(__file__).resolve().parent
p=json.loads((root/'package.json').read_text(encoding='utf-8-sig'))
name,version,publisher=(p[k] for k in ('name','version','publisher'))
vsix=f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="{name}" Version="{version}" Publisher="{publisher}" />
    <DisplayName>{escape(p['displayName'])}</DisplayName>
    <License>extension/LICENSE</License>
    <Description xml:space="preserve">{escape(p['description'])}</Description>
    <Categories>{','.join(p['categories'])}</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="{p['engines']['vscode']}" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
  </Assets>
</PackageManifest>'''
content='''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="exe" ContentType="application/octet-stream" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="md" ContentType="text/markdown" />
  <Default Extension="java" ContentType="text/plain" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="html" ContentType="text/html" />
  <Default Extension="txt" ContentType="text/plain" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="png" ContentType="image/png" />
  <Override PartName="/extension/LICENSE" ContentType="text/plain" />
</Types>'''
files=[
    *(root / name for name in ('package.json', 'extension.js', 'README.md', 'DEVELOPMENT.md', 'CHANGELOG.md', 'LICENSE')),
    *sorted(f for f in (root / 'media').rglob('*') if f.is_file()),
    *sorted(f for f in (root / 'lib').iterdir() if f.suffix in ('.js', '.json', '.java')),
]
out=root/'dist'/f'{name}-{version}.vsix'; out.parent.mkdir(exist_ok=True)
with ZipFile(out,'w',ZIP_DEFLATED) as z:
    z.writestr('extension.vsixmanifest',vsix)
    z.writestr('[Content_Types].xml',content)
    for f in files: z.write(f,'extension/'+f.relative_to(root).as_posix())
    if os.name == 'nt':
        net = Path(os.environ['WINDIR']) / 'Microsoft.NET'
        csc = next(net / f / 'v4.0.30319' / 'csc.exe' for f in ('Framework64', 'Framework')
                   if (net / f / 'v4.0.30319' / 'csc.exe').is_file())
        with TemporaryDirectory(prefix='voxel-cursor-') as temp:
            exe = Path(temp) / 'CenterCursor.exe'
            subprocess.run([str(csc), '/nologo', '/target:winexe', '/optimize+', '/out:' + str(exe),
                            str(root / 'lib' / 'CenterCursor.cs')], check=True)
            z.write(exe, 'extension/lib/CenterCursor.exe')
with ZipFile(out) as z: assert z.testzip() is None
print(out, out.stat().st_size)
