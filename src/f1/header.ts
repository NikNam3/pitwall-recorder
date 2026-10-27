// Minimal F1 25 UDP packet header peek. The recorder only needs these fields to split files per
// session and to show status; packets are always stored raw, whatever they contain.

export const PACKET_HEADER_SIZE = 29;
export const EXPECTED_PACKET_FORMAT = 2025;

export interface PacketHeader {
  packetFormat: number;
  gameYear: number;
  packetId: number;
  sessionUID: bigint;
  sessionTime: number;
  frameIdentifier: number;
  playerCarIndex: number;
}

export const PACKET_NAMES: Readonly<Record<number, string>> = {
  0: 'Motion',
  1: 'Session',
  2: 'LapData',
  3: 'Event',
  4: 'Participants',
  5: 'CarSetups',
  6: 'CarTelemetry',
  7: 'CarStatus',
  8: 'FinalClassification',
  9: 'LobbyInfo',
  10: 'CarDamage',
  11: 'SessionHistory',
  12: 'TyreSets',
  13: 'MotionEx',
  14: 'TimeTrial',
  15: 'LapPositions',
};

export function packetName(id: number): string {
  return PACKET_NAMES[id] ?? `Unknown(${id})`;
}

/** Returns null for datagrams too short to carry a header. */
export function peekHeader(data: Uint8Array): PacketHeader | null {
  if (data.length < PACKET_HEADER_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    packetFormat: view.getUint16(0, true),
    gameYear: view.getUint8(2),
    packetId: view.getUint8(6),
    sessionUID: view.getBigUint64(7, true),
    sessionTime: view.getFloat32(15, true),
    frameIdentifier: view.getUint32(19, true),
    playerCarIndex: view.getUint8(27),
  };
}
