"""Build/import a private Tomo1.2 compatibility image. Does not deploy it."""
import hashlib,json,shlex,shutil,subprocess
from datetime import datetime,timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
TAG="localhost/replay-tomo-api:1.2.0-envelope.1"

def run(args):
    subprocess.run(args,check=True)

def main():
    evidence=json.loads((ROOT/"evidence/platform/tomo-runtime-images-1.2.0.json").read_text())
    entry=next(x for x in evidence["images"] if "/kaizen-api:" in x["image"])
    archive=ROOT/"data/platform/tomo-image"/entry["file"]
    h=hashlib.sha256()
    with archive.open("rb") as f:
        for chunk in iter(lambda:f.read(1024*1024),b""):h.update(chunk)
    assert h.hexdigest()==entry["sha256"]
    destination=ROOT/"data/platform/tomo-forwarding-envelope-1-verified"
    destination.mkdir(exist_ok=False)
    patch=ROOT/"scripts/platform/patch-tomo-forwarding.py"
    shutil.copy2(patch,destination/patch.name)
    run(["podman","load","-i",str(archive)])
    info=json.loads(subprocess.check_output(["podman","image","inspect",entry["image"]]))[0]
    base_id=info["Id"]
    original_user=info["Config"].get("User") or "root"
    assert original_user.replace(":","").replace("-","").isalnum()
    dockerfile=(f"FROM {base_id}\nUSER root\nCOPY patch-tomo-forwarding.py /tmp/replay-envelope-patch.py\n"
                "RUN python /tmp/replay-envelope-patch.py && rm /tmp/replay-envelope-patch.py\n"
                f"USER {original_user}\n")
    (destination/"Dockerfile").write_text(dockerfile)
    run(["podman","build","--pull=never","-t",TAG,str(destination)])
    image_info=json.loads(subprocess.check_output(["podman","image","inspect",TAG]))[0]
    oci=destination/"image.oci"
    run(["podman","save","--format","oci-archive","-o",str(oci),TAG])
    run(["podman","machine","ssh","kamiwaza-harness-poc",shlex.join(["sudo","k0s","ctr","images","import",str(oci)])])
    proof={"at":datetime.now(timezone.utc).isoformat(),"image":TAG,"imageId":image_info["Id"],"baseImage":entry["image"],"baseImageId":base_id,"baseArchiveSha256":entry["sha256"],"patchSha256":hashlib.sha256(patch.read_bytes()).hexdigest(),"preservedUser":original_user,"deployed":False,"change":"Preserve seven additional signed Core1.2 envelope fields; no token/signature fabrication, no vendor-source distribution"}
    out=ROOT/"evidence/platform/tomo-forwarding-image-1.2.0-envelope.1.json"
    with out.open("x") as f:json.dump(proof,f,indent=2)
    print(json.dumps(proof))

if __name__=="__main__":main()
