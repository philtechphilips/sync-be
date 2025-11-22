import { genSalt, hash, compare } from 'bcryptjs';

const hashPassword = async function (password: string) {
  const salt = await genSalt(10);
  const hashedPassword = await hash(password, salt);
  return hashedPassword;
};

const validatePassword = async function (
  reqPassword: string,
  userPassword: string,
) {
  const isValid = await compare(reqPassword, userPassword);
  if (isValid) return true;
  return false;
};

export { hashPassword, validatePassword };
