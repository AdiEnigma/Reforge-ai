import { BaseRepository } from "./base-repository.js";

export class ProjectRepository extends BaseRepository {
  constructor(db = null) {
    super("projects", db);
  }

  async listByOrganization(organizationId, limit = 50, offset = 0) {
    return this.query.where({ organization_id: organizationId }).limit(limit).offset(offset);
  }
}
