/**
 * Seeds the Store table with departments + numbered stores from the
 * master spreadsheet. Run once after deployment, or re-run any time —
 * existing rows with matching names are skipped (idempotent).
 *
 *   cd backend/api
 *   npx ts-node scripts/seed-categories-stores.ts
 *
 * Note: expense categories are hardcoded on the frontend (see the
 * upload page CATEGORIES const) — no DB seeding needed for those.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

// Departments — no store code, just a name.
const DEPARTMENTS: string[] = [
  'Store',
  'HQ',
  'FINANCE',
  'HR',
  'IT',
  'OPERATIONS',
  'TRAINING SCHOOL',
  'MAINTENANCE',
  'INTERNAL AUDIT',
  'MERCHANDISING',
  'WAREHOUSE',
  'VUYATEX',
  '313',
  'KARE - BASIC SUPPLY',
  'IC NORATH',
  'FUSION CAR RENTALS',
];

// Numbered stores — [code, name]
const STORES: Array<[string, string]> = [
  ['0101', '501 West Street'],
  ['0166', '85 on Field'],
  ['0186', 'Bellville CBD'],
  ['0191', 'Bethal'],
  ['0210', 'Blm Plaza'],
  ['0122', 'Bloemfontein'],
  ['0163', 'Boardwalk'],
  ['0202', 'Boksburg'],
  ['0192', 'Buchanan Chambers'],
  ['0151', 'Burgesfort'],
  ['0179', 'Cape Town CBD'],
  ['0197', 'Central Park Bloem'],
  ['0169', 'Chatsworth'],
  ['0189', 'Chris Hani Crossing'],
  ['0115', 'Church Street - PMB'],
  ['0187', 'Circus Triangle'],
  ['0213', 'Cresta Mall'],
  ['0174', 'East Rand Mall'],
  ['0218', 'Eloff Street (JHB)'],
  ['0217', 'Empangeni'],
  ['0194', 'Ermelo'],
  ['0176', 'Fashion Fusion Online'],
  ['0214', 'Festival Mall - FF'],
  ['0119', 'Fusion Man'],
  ['0161', 'Galleria Mall'],
  ['0138', 'Greenacres - P.E'],
  ['0170', 'Hillcrest'],
  ['0135', 'Kagiso - JHB'],
  ['0152', 'King Williams Town'],
  ['0149', 'Kokstad CBD'],
  ['0150', 'Ladysmith CBD'],
  ['0211', 'Lakeside Mall'],
  ['0165', 'Lister'],
  ['0158', 'Lowveld'],
  ['0206', 'Madeira Street - Mthatha CBD'],
  ['0195', 'Mall Of Gateway'],
  ['0190', 'Mall of Tembisa'],
  ['0182', 'Mamelodi'],
  ['0200', 'Maponya Mall'],
  ['0131', 'Markade'],
  ['0123', 'Matatiele'],
  ['0207', 'Menlyn Mall - Pop Up'],
  ['0144', 'Mthatha Plaza'],
  ['0113', 'Newcastle - Harding Street'],
  ['0188', 'Newtown Junction'],
  ['0130', 'Oxford Street - East London'],
  ['0204', 'Pan Africa Mall - Alex'],
  ['0168', 'Phoenix Plaza'],
  ['0110', 'Pinewalk Centre'],
  ['0196', 'PMB CBD'],
  ['0153', 'Polokwane (CBD)'],
  ['0116', 'Port Shepstone'],
  ['0212', 'President Hyper Vaal - FF'],
  ['0172', 'Pretoria Queen'],
  ['0205', 'Princess Mkabayi Mall - Vryheid'],
  ['0208', 'Promenade Mall'],
  ['0127', 'Queenstown'],
  ['0129', 'Richards Bay'],
  ['0142', 'Salt River - Cape Town'],
  ['0181', 'Secunda'],
  ['0215', 'Soshanguve Mall'],
  ['0175', 'Southgate Mall'],
  ['0105', 'Southway Mall'],
  ['0133', 'Soweto - Bara Precinct'],
  ['0106', 'Stamford Hill'],
  ['0148', 'Stanger CBD'],
  ['0203', 'Taxi Centre (Polokwane)'],
  ['0134', 'Thembisa - JHB'],
  ['0177', 'Thohoyandou CBD'],
  ['0201', 'Town Square Alberton'],
  ['0132', 'Tramshed'],
  ['0146', 'Ulundi'],
  ['0156', 'Umlazi Mega City'],
  ['0112', 'Verulam - Wick Street'],
  ['0183', 'Victoria Road Cape Town'],
  ['0164', 'Vincent Park'],
  ['0157', 'Vryheid CBD'],
  ['0209', 'Westgate Mall'],
  ['0141', 'Woodmead - JHB'],
  ['0178', 'Wynberg'],
  // Evolve sub-brand
  ['2009', 'Evolve Boardwalk'],
  ['2003', 'Evolve Carton Centre'],
  ['2010', 'Evolve CBD Field Street'],
  ['2006', 'Evolve Galleria'],
  ['2001', 'Evolve Online'],
  ['2007', 'Evolve Promenade'],
  ['2008', 'Evolve Soshanguwe'],
  ['2002', 'Evolve Workshop'],
  // My Big Brand sub-brand
  ['1114', 'My Big Brand POP-UP'],
  ['1115', 'My Big Brand Stamford Hill'],
  ['1117', 'My Big Brands Pinetown'],
  // Fusion Connect sub-brand
  ['5002', 'Fusion Connect - 85 Field'],
  ['5003', 'Fusion Connect - Phoenix'],
  ['5005', 'Fusion Connect - PMB CBD'],
  ['5004', 'Fusion Connect - Galleria'],
];

async function main() {
  const prisma = new PrismaClient();
  let created = 0;
  let skipped = 0;

  try {
    // Departments first.
    for (const dept of DEPARTMENTS) {
      const exists = await prisma.store.findUnique({
        where: { name: dept },
        select: { id: true },
      });
      if (exists) {
        skipped++;
        continue;
      }
      await prisma.store.create({
        data: { name: dept, code: null, active: true },
      });
      created++;
    }

    // Numbered stores — display as "0218 - Eloff Street (JHB)" so the
    // dropdown stays sorted by code and matches the master sheet.
    for (const [code, label] of STORES) {
      const fullName = `${code} - ${label}`;
      const exists = await prisma.store.findUnique({
        where: { name: fullName },
        select: { id: true },
      });
      if (exists) {
        skipped++;
        continue;
      }
      await prisma.store.create({
        data: { name: fullName, code, active: true },
      });
      created++;
    }

    console.log(`\n✓ Seed complete: ${created} created, ${skipped} already existed`);
    console.log(`Total departments + stores in master sheet: ${DEPARTMENTS.length + STORES.length}`);
  } catch (err) {
    console.error('Failed:', (err as Error).message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
