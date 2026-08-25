import bcrypt from "bcryptjs";

export async function hashPassword(password: string): Promise<string> {
  const rounds = 12;
  return bcrypt.hash(password, rounds);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
