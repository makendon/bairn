# Bairn

Calm photo puzzle for a short parent break. One interactive loop on the phone — no accounts, no AI.

## Sol’s loop

1. Open app  
2. One-time photos access (or Try demo)  
3. Auto-pick a recent image  
4. Chunky 3×3 tiles  
5. On finish → next photo auto-loads  
6. Soft outing timer (~25 min) ends the session  

## Run

```bash
npm install
npm run dev
```

Dev server binds `0.0.0.0:5173` (phone-friendly on the same network). Local: http://localhost:5173

## Preview notes

- **Desktop / Computer tab:** use **Try demo** — built-in illustration pack, no gallery needed.  
- **Phone:** first visit → **Use photos** → multi-select from gallery once; pool stored in IndexedDB. Thereafter auto-pick. Quiet **···** / “Add more photos” for parents only.

## Stack

Vite + vanilla JS. No account wall, no UI kit.
