# cuda_dlls.py — 윈도우: pip 으로 깐 nvidia-cublas·cudnn 의 DLL 폴더(site-packages/nvidia/*/bin)를 붙인다 (받아쓰기 도구 whisper_device 와 같은 일)
import os


def add():
    if os.name != 'nt': return []
    import site, glob
    roots = [p for p in site.getsitepackages() + [site.getusersitepackages()] if os.path.isdir(p)]
    dirs = sorted({d for r in roots for d in glob.glob(os.path.join(r, 'nvidia', '*', 'bin')) if os.path.isdir(d)})
    for d in dirs:
        os.environ['PATH'] = d + os.pathsep + os.environ.get('PATH', '')
        try: os.add_dll_directory(d)
        except (OSError, AttributeError): pass
    return dirs
