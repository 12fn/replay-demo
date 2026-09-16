import {expect,it} from 'vitest';
import {deploymentOptions} from '../../scripts/platform/deployment-options';
it('uses HTTPS cookies and disables operator accommodations by default',()=>{expect(deploymentOptions([])).toMatchObject({cookieSecure:true,operatorFileImport:false,legacyRecordings:false});});
it('requires distinct explicit opt-ins for the HTTP tunnel, credential-file import and legacy access',()=>{expect(deploymentOptions(['--loopback-http'])).toMatchObject({cookieSecure:false,operatorFileImport:false,legacyRecordings:false});expect(deploymentOptions(['--operator-file-import','--allow-legacy-recordings'])).toMatchObject({cookieSecure:true,operatorFileImport:true,legacyRecordings:true});});
it('fails before platform I/O on an unknown deployment flag',()=>{expect(()=>deploymentOptions(['--insecure'])).toThrow(/Unknown deployment flag/);});
