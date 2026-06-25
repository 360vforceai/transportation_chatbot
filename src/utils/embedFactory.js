const { EmbedBuilder } = require('discord.js');



function createParkingEmbed(building, lots) {
  const bestLot = lots[0];

  const otherLots = lots
    .slice(1)
    .map(lot => `• **${lot.name}** (${lot.campus}) — ${lot.walkMinutes} min walk`)
    .join('\n') || 'None nearby.';

  const mapsLink = `https://www.google.com/maps?q=${bestLot.lat},${bestLot.lng}`;
  const status = bestLot.status ?? '✅ Open to all';

  const embed = new EmbedBuilder()
    .setColor(0xcc0033)
    .setTitle(`🅿️ Parking near ${building.name}`)
    .setURL(mapsLink)
    .addFields(
      {
        name: `🥇 ${bestLot.name} (${bestLot.campus})`,
        value: [
          `🚶 ${bestLot.walkMinutes} min walk · ${bestLot.distanceMiles.toFixed(2)} mi`,
          status,
          '\u200b',
          `[Open in Google Maps](${mapsLink})`
        ].join('\n')
      },
      {
        name: 'Other Nearby Lots',
        value: otherLots
      }
    )
    .setFooter({ text: 'Rutgers Transportation Assistant' });

  return embed;
}

module.exports = { createParkingEmbed };