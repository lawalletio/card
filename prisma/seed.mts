import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const cardDesigns = [
  {
    uuid: 'fd54e006-a714-4699-9fd0-3898c622aed8',
    name: 'Blank',
    description: 'Blank card, no printing',
  },
  {
    uuid: 'c252f9d8-6c89-4e07-a481-82cef8169a14',
    name: 'Halloween',
    description: 'Halloween 2023 theme',
  },
  {
    uuid: '5a69866c-06d1-4761-be8e-28d52c337abd',
    name: 'LABITCONF',
    description: 'LABITCONF 2023 theme',
  },
  {
    uuid: '0946745e-a0cd-4ce1-af4f-6e1b5bb2a56f',
    name: 'LABITCONF (Green)',
    description: 'LABITCONF 2023 theme (green color pallette)',
  },
  {
    uuid: 'f4c5d58b-1476-470a-880c-e42ef2d95484',
    name: 'To the Moon',
    description: '"To the Moon" theme',
  },
  {
    uuid: 'b1b95247-98b8-4d1c-ba2c-f11a743fddc4',
    name: 'Lunarpunk',
    description: '"Lunarpunk" theme',
  },
  {
    uuid: '43171fff-5b0a-4f89-aa3b-465db7792de9',
    name: 'Solarpunk',
    description: '"Solarpunk" theme',
  },
  {
    uuid: '70d31cc4-cc8b-4587-8681-246616195ddf',
    name: 'Honey Badger',
    description: '"Honey Badger" theme',
  },
  {
    uuid: 'c2f96146-e3e5-405b-b3e0-5c7ef05473f7',
    name: 'Lightning',
    description: '"Lightning" theme',
  },
  {
    uuid: '6783cc8c-79d0-4e32-8457-aa13bb34649c',
    name: 'Revolucion',
    description: '"Revolucion" theme',
  },
  {
    uuid: 'a0f6803c-a75a-49d5-89e9-fb091aab4ede',
    name: 'Halving is Coming',
    description: '"Halving is Coming" theme',
  },
  {
    uuid: '0f7a4368-03ac-4b11-aafe-41a520759e2d',
    name: "There's no Second Best",
    description: "\"There's no Second Best\" theme",
  },
];

async function main() {
  await prisma.design.createMany({ data: cardDesigns });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  })
;
