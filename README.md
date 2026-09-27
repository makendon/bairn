# Bairn

Calm photo puzzle for a short parent break. One interactive loop on the phone — no accounts, no AI.

## Sol’s loop

1. Open app  
2. One-time photos access (or Try demo)  
3. Auto-pick a recent image  
4. Difficulty once at outing start (default easy = 2×2 / 4 tiles; medium 3×3; hard 4×4)  
5. Solve → full photo hold ~10s or Next, then next scramble  
6. Soft outing timer (~25 min) ends the session  

## Run

```bash
npm install
npm run dev
```

Dev server binds `0.0.0.0:5173` (phone-friendly on the same network). Local: http://localhost:5173

## Preview notes

- **Desktop / Computer tab:** use **Try demo** — built-in illustration pack, no gallery needed.  
- **Phone:** first visit → **Use photos** → multi-select from gallery once; pool stored in IndexedDB. Thereafter auto-pick. Quiet mid-puzzle **···** with a “hold to add photos” hint — long-press (~700ms) adds photos; tap does nothing (kid-safe).

## Stack

Vite + vanilla JS. No account wall, no UI kit.
