// Prepares tests/.work for the end-to-end tests (Linux, run once):
// - small real models from Hugging Face (Qwen3.5 0.8B and 2B, with their
//   vision projectors), served to the app by fixtures/mock-hf.js;
// - a fake nvidia-smi (fixtures/fakebin), a fake Ollama folder, a fake
//   LM Studio folder, and folders with split, broken and incomplete models;
// - a link to a llama-server you built: LLAMA_SERVER=/path/to/llama-server.
// With FEATURES=1 also (about 7 GB) what kb, voice, image and vscode tests need:
// the Qwen3-Embedding model, whisper.cpp's Linux build with a small model and
// two speech samples, stable-diffusion.cpp's Linux build with Z-Image
// Turbo files (smaller Q3 versions than the app downloads), and VSCodium's server.
//
// Usage: LLAMA_SERVER=~/llama.cpp/build/bin/llama-server [FEATURES=1] node tests/setup.js

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const WORK = path.join(__dirname, '.work');

const MODELS = [
  { repo: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'Qwen3.5-0.8B-Q4_K_M.gguf', as: 'Qwen3.5-0.8B-Q4_K_M.gguf' },
  { repo: 'unsloth/Qwen3.5-0.8B-GGUF', file: 'mmproj-BF16.gguf', as: 'Qwen3.5-0.8B-mmproj-BF16.gguf' },
  { repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'Qwen3.5-2B-Q4_K_M.gguf', as: 'Qwen3.5-2B-Q4_K_M.gguf' },
  { repo: 'unsloth/Qwen3.5-2B-GGUF', file: 'mmproj-BF16.gguf', as: 'mmproj-BF16.gguf' },
];

const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const link = (target, at) => {
  fs.rmSync(at, { force: true, recursive: true });
  fs.symlinkSync(target, at);
};
const hardlink = (from, to) => {
  fs.rmSync(to, { force: true });
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
};

function download(url, to) {
  if (fs.existsSync(to)) return;
  console.log('downloading', url);
  execFileSync('curl', ['-sSL', '--fail', '-o', `${to}.part`, url], { stdio: 'inherit' });
  fs.renameSync(`${to}.part`, to);
}

function features() {
  const hf = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`;
  mkdir(path.join(WORK, 'models'));
  download(hf('Qwen/Qwen3-Embedding-0.6B-GGUF', 'Qwen3-Embedding-0.6B-Q8_0.gguf'), path.join(WORK, 'models', 'Qwen3-Embedding-0.6B-Q8_0.gguf'));

  const w = path.join(WORK, 'whisper');
  mkdir(w);
  download('https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-ubuntu-x64.tar.gz', path.join(w, 'w.tar.gz'));
  if (!fs.existsSync(path.join(w, 'whisper-bin-ubuntu-x64', 'whisper-server'))) execFileSync('tar', ['-xzf', path.join(w, 'w.tar.gz'), '-C', w]);
  download(hf('ggerganov/whisper.cpp', 'ggml-small-q5_1.bin'), path.join(w, 'ggml-small-q5_1.bin'));
  download('https://github.com/ggml-org/whisper.cpp/raw/master/samples/jfk.wav', path.join(w, 'jfk.wav'));
  // Arabic Speech Corpus (Nawar Halabi, CC BY 4.0), test sentence 2, through
  // the Hugging Face dataset viewer (its audio links are signed, so asked first).
  if (!fs.existsSync(path.join(w, 'ar-sample.wav'))) {
    const rows = JSON.parse(execFileSync('curl', ['-sSL', '--fail', 'https://datasets-server.huggingface.co/rows?dataset=tunis-ai/arabic_speech_corpus&config=default&split=test&offset=1&length=1']).toString());
    download(rows.rows[0].row.audio[0].src, path.join(w, 'ar-sample.wav'));
  }

  const sd = path.join(WORK, 'sdcpp');
  mkdir(sd);
  download('https://github.com/leejet/stable-diffusion.cpp/releases/download/master-929-3f8527a/sd-master-3f8527a-bin-Linux-Ubuntu-24.04-x86_64.zip', path.join(sd, 'sd.zip'));
  if (!fs.existsSync(path.join(sd, 'sd-server'))) execFileSync('unzip', ['-o', '-q', path.join(sd, 'sd.zip'), '-d', sd]);
  fs.chmodSync(path.join(sd, 'sd-server'), 0o755);
  // VSCodium's web server (MIT) for the VS Code page; the Linux build of the
  // same release the app downloads for Windows.
  const vs = path.join(WORK, 'vscodium');
  mkdir(vs);
  const V = '1.135.06055';
  download(`https://github.com/VSCodium/vscodium/releases/download/${V}/vscodium-reh-web-linux-x64-${V}.tar.gz`, path.join(vs, 'reh-linux.tar.gz'));
  if (!fs.existsSync(path.join(vs, 'linux', 'out', 'server-main.js'))) {
    mkdir(path.join(vs, 'linux'));
    execFileSync('tar', ['-xzf', path.join(vs, 'reh-linux.tar.gz'), '-C', path.join(vs, 'linux')]);
  }

  const img = path.join(WORK, 'images');
  mkdir(img);
  download(hf('leejet/Z-Image-Turbo-GGUF', 'z_image_turbo-Q3_K.gguf'), path.join(img, 'z_image_turbo-Q3_K.gguf'));
  download(hf('Comfy-Org/z_image_turbo', 'split_files/vae/ae.safetensors'), path.join(img, 'ae.safetensors'));
  download(hf('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q3_K_M.gguf'), path.join(img, 'Qwen3-4B-Instruct-2507-Q3_K_M.gguf'));
}

function main() {
  const server = process.env.LLAMA_SERVER;
  if (!server || !fs.existsSync(server)) {
    console.error('Set LLAMA_SERVER to a llama-server binary (build llama.cpp first).');
    process.exit(1);
  }
  mkdir(WORK);

  // Same layout the tests expect: <work>/llama.cpp/build/bin/llama-server.
  mkdir(path.join(WORK, 'llama.cpp', 'build', 'bin'));
  link(path.resolve(server), path.join(WORK, 'llama.cpp', 'build', 'bin', 'llama-server'));

  // Fake nvidia-smi: copied, since tests write its temp/thermal files next to it.
  mkdir(path.join(WORK, 'fakebin'));
  fs.copyFileSync(path.join(FIX, 'fakebin', 'nvidia-smi'), path.join(WORK, 'fakebin', 'nvidia-smi'));
  fs.chmodSync(path.join(WORK, 'fakebin', 'nvidia-smi'), 0o755);
  for (const f of ['mock-hf.js', 'mock-lhm.js']) link(path.join(FIX, f), path.join(WORK, f));
  link(path.join(FIX, 'docs'), path.join(WORK, 'docs'));

  // Models for the mock Hugging Face server.
  const hf = path.join(WORK, 'hfsrc');
  mkdir(hf);
  for (const m of MODELS) download(`https://huggingface.co/${m.repo}/resolve/main/${m.file}`, path.join(hf, m.as));

  // Fake Ollama: manifests from fixtures, blobs linked to the real models.
  const ol = path.join(WORK, 'fake-ollama');
  fs.rmSync(ol, { recursive: true, force: true });
  fs.cpSync(path.join(FIX, 'ollama'), ol, { recursive: true });
  mkdir(path.join(ol, 'blobs'));
  hardlink(path.join(hf, 'Qwen3.5-2B-Q4_K_M.gguf'), path.join(ol, 'blobs', `sha256-${'a'.repeat(64)}`));
  hardlink(path.join(hf, 'mmproj-BF16.gguf'), path.join(ol, 'blobs', `sha256-${'b'.repeat(64)}`));
  hardlink(path.join(hf, 'Qwen3.5-0.8B-Q4_K_M.gguf'), path.join(ol, 'blobs', `sha256-${'c'.repeat(64)}`));

  // Fake LM Studio home, and a folder with split / broken / incomplete models.
  const imp = path.join(WORK, 'imp');
  fs.rmSync(imp, { recursive: true, force: true });
  const lms = path.join(imp, 'lmhome', '.lmstudio', 'models', 'unsloth', 'Qwen3.5-0.8B-GGUF');
  mkdir(lms);
  hardlink(path.join(hf, 'Qwen3.5-0.8B-Q4_K_M.gguf'), path.join(lms, 'Qwen3.5-0.8B-Q4_K_M.gguf'));
  hardlink(path.join(hf, 'Qwen3.5-0.8B-mmproj-BF16.gguf'), path.join(lms, 'mmproj-Qwen3.5-0.8B-BF16.gguf'));
  for (const d of ['split', 'broken', 'partial']) mkdir(path.join(imp, 'myfolder', d));
  const splitTool = path.join(path.dirname(server), 'llama-gguf-split');
  if (fs.existsSync(splitTool)) {
    execFileSync(splitTool, ['--split', '--split-max-size', '300M', path.join(hf, 'Qwen3.5-0.8B-Q4_K_M.gguf'), path.join(imp, 'myfolder', 'split', 'MySplit-Q4_K_M')], { stdio: 'ignore' });
    fs.copyFileSync(path.join(imp, 'myfolder', 'split', 'MySplit-Q4_K_M-00001-of-00002.gguf'), path.join(imp, 'myfolder', 'partial', 'Half-00001-of-00002.gguf'));
  } else {
    console.warn('llama-gguf-split not found next to llama-server: the split-model checks will fail.');
  }
  fs.writeFileSync(path.join(imp, 'myfolder', 'broken', 'notreally.gguf'), Buffer.alloc(1000000, 7));

  if (process.env.FEATURES === '1') features();

  // Start with the small CPU model chosen, so the first test downloads it
  // from the mock server instead of stopping at the "choose a model" screen.
  const home = path.join(WORK, 'e2e-home', 'Blazma AI');
  mkdir(home);
  const settingsFile = path.join(home, 'settings.json');
  if (!fs.existsSync(settingsFile)) fs.writeFileSync(settingsFile, JSON.stringify({ activeModelId: 'qwen3.5-2b', tourDone: true }));
  console.log('ready:', path.relative(ROOT, WORK));
}

main();
