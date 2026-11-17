import { BaseRepository } from "./base-repository.js";

export class OrganizationRepository extends BaseRepository {
  constructor(db = null) {
    super("organizations", db);
  }

  async findBySlug(slug) {
    return this.query.where({ slug }).first();
  }
}
