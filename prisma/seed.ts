import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const cardDesigns = [
  {
    name: 'Blank',
    description: 'Blank card, no printing',
  },
  {
    name: 'Halloween',
    description: 'Halloween 2023 theme',
  },
  {
    name: 'LABITCONF',
    description: 'LABITCONF 2023 theme',
  },
  {
    name: 'LABITCONF (Green)',
    description: 'LABITCONF 2023 theme (green color pallette)',
  },
  {
    name: 'To the Moon',
    description: '"To the Moon" theme',
  },
  {
    name: 'Lunarpunk',
    description: '"Lunarpunk" theme',
  },
  {
    name: 'Solarpunk',
    description: '"Solarpunk" theme',
  },
  {
    name: 'Honey Badger',
    description: '"Honey Badger" theme',
  },
  {
    name: 'Lightning',
    description: '"Lightning" theme',
  },
  {
    name: 'Revolucion',
    description: '"Revolucion" theme',
  },
  {
    name: 'Halving is Coming',
    description: '"Halving is Coming" theme',
  },
  {
    name: "There's no Second Best",
    description: "\"There's no Second Best\" theme",
  },
  {
    name: "There's no Second Best",
    description: "\"There's no Second Best\" theme",
  },
];

async function main() {
  prisma.design.createMany({ data: cardDesigns });
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
