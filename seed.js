const fetch = require('node-fetch');
const { parse } = require('csv-parse');
const { initializeDatabase, getDb } = require('./database.js');

let pinyinFn = null;

async function loadPinyin() {
    try {
        const mod = await import('pinyin-pro');
        pinyinFn = mod.pinyin || (mod.default && mod.default.pinyin);
        if (pinyinFn) {
            const test = pinyinFn('台泥', { nonZh: 'consecutive' });
            console.log(`✅ pinyin-pro loaded. Test: 台泥 → ${test}`);
        } else {
            console.warn('⚠️  pinyin-pro loaded but pinyin function not found. Keys:', Object.keys(mod));
        }
    } catch (e) {
        console.log('📦 pinyin-pro not found, installing...');
        const { execSync } = require('child_process');
        try {
            execSync('npm install pinyin-pro --save', { stdio: 'inherit' });
            const mod = await import('pinyin-pro');
            pinyinFn = mod.pinyin || (mod.default && mod.default.pinyin);
            if (pinyinFn) {
                console.log('✅ pinyin-pro installed and loaded.');
            }
        } catch (e2) {
            console.warn('⚠️  Could not install pinyin-pro, seeding without pinyin.');
        }
    }
}

function toPinyin(name) {
    if (!pinyinFn || !name) return null;
    // Only convert Chinese characters, leave non-Chinese as-is
    const result = pinyinFn(name, { nonZh: 'consecutive' });
    // Title case each word
    return result.replace(/(^|\s)\w/g, c => c.toUpperCase());
}

const DATA_SOURCES = {
    TSE: 'https://mopsfin.twse.com.tw/opendata/t187ap03_L.csv', // Listed companies
    TPEx: 'https://mopsfin.twse.com.tw/opendata/t187ap03_O.csv', // OTC companies
    ESB: 'https://mopsfin.twse.com.tw/opendata/t187ap03_R.csv'   // Emerging companies
};

// --- Seeding Functions ---

async function fetchAndSeedFromSource(db, url, marketName) {
    console.log(`Fetching company list for ${marketName} from ${url}...`);
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Failed to fetch data for ${marketName}: ${response.statusText}`);
    }

    const parser = response.body.pipe(parse({ from_line: 2 }));
    const stmt = await db.prepare('INSERT OR REPLACE INTO companies (code, name, name_en, name_pinyin) VALUES (?, ?, ?, ?)');
    let count = 0;

    for await (const record of parser) {
        const companyCode = record[1];
        const companyName = record[3] || record[2];
        const companyNameEn = record[27] || null;
        const companyPinyin = toPinyin(companyName);
        if (companyCode && companyName) {
            if (count === 0 && companyPinyin) {
                console.log(`   Sample: ${companyCode} ${companyName} → ${companyPinyin}`);
            }
            await stmt.run(companyCode, companyName, companyNameEn, companyPinyin);
            count++;
        }
    }
    await stmt.finalize();
    console.log(`✅ Successfully seeded ${count} companies from ${marketName}.`);
    return count;
}


async function seedAllCompanyData() {
    let totalCount = 0;
    try {
        await loadPinyin();
        console.log('🌱 Starting comprehensive company data seeding process...');
        await initializeDatabase();
        const db = getDb();

        await db.run('BEGIN TRANSACTION');

        for (const [marketName, url] of Object.entries(DATA_SOURCES)) {
            const count = await fetchAndSeedFromSource(db, url, marketName);
            totalCount += count;
        }
        
        console.log(`\n🎉 Company list seeding complete! Total companies seeded: ${totalCount}.`);

        await db.run('COMMIT');
        console.log(`🎉🎉🎉 Full seeding process complete!`);

    } catch (error) {
        console.error('❌ An error occurred during the seeding process:', error);
        const db = getDb();
        if (db) {
            await db.run('ROLLBACK');
        }
        process.exit(1);
    }
}

seedAllCompanyData();