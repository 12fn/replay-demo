/** Explicit browser transport and operator-only accommodations; no platform I/O. */
export function deploymentOptions(args:string[]){
 const flags=new Set(args);
 for(const flag of flags)if(!['--loopback-http','--operator-file-import','--allow-legacy-recordings'].includes(flag))throw Error('Unknown deployment flag');
 const loopbackHttp=flags.has('--loopback-http');
 return {cookieSecure:!loopbackHttp,operatorFileImport:flags.has('--operator-file-import'),legacyRecordings:flags.has('--allow-legacy-recordings'),network:loopbackHttp?'Explicit private loopback HTTP accommodation; browser cookie Secure=false. Public ingress is not qualified.':'HTTPS browser target; Secure cookies enabled. Release must qualify the actual HTTPS/App Garden launch path.'};
}
