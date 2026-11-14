# Files not in this repository

These are too large for GitHub (over 100 MB) and are left out:

- `app/src-tauri/resources/sam/encoder.onnx` (134 MB): the SAM 2.1 tiny image encoder used by the "Object" mask. Rebuild it with the scripts that were in `models-pending/sam21-tiny/` (Python 3.12, onnx, onnxsim) or ask the maker for the file. Without it, the program will not compile.
- `app/src-tauri/resources/face-parsing-resnet18.onnx` (51 MB): the face-parsing model used by the portrait tools. It was trained on CelebAMask-HQ, which is for non-commercial research only, so it is not published here and is due to be replaced. Without it, the program will not compile.
- `models-pending/`: the unconverted source models and conversion scripts.
- `installer/*.exe`: built installers (about 290 MB each).
- `screens/`, `clone-screens/`, `diffs/`: research screenshots.

Licences of the models are in `licences/` and `app/src-tauri/resources/MODEL-LICENCES.txt`.
