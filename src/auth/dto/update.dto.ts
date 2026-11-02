import { UpdateProfileDto } from './update-profile.dto';

/** PATCH /v1/auth accepts the same safe profile fields as /v1/auth/profile. */
export class UpdateAuthDto extends UpdateProfileDto {}
