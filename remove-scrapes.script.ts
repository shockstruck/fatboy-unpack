import fs from 'fs';

fs.readdirSync('./repack-data-scrapes').forEach(file => {
  fs.unlinkSync(`./repack-data-scrapes/${file}`);
});

console.log('[FatBoy Unpack] Scrapes removed because update triggered.');