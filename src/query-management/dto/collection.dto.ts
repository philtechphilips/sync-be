import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateCollectionDto {
  @IsNotEmpty()
  @IsString()
  name: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class UpdateCollectionDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;
}
