/**
 * graphql.ts — the GraphQL surface at /api/graphql.
 *
 * A compact parser (operations, fragments, aliases, variables, input
 * objects) and executor over a schema registry that also drives
 * introspection (__type / __schema). Resolvers read and write the same
 * store as REST, so ids and objects agree across surfaces. Global ids are
 * opaque base64 "Kind:databaseId" strings — stable, and never equal to
 * the plain numeric id.
 */
import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Forge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import {
  createIssueRecord,
  createPullRecord,
  mergePull,
  pullFiles,
  pullValidationError,
} from './rest.ts';

// ------------------------------------------------------------ global node ids

export function encodeNodeId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function decodeNodeId(raw: string): { kind: string; id: number } | null {
  try {
    const text = Buffer.from(raw, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    const id = Number(text.slice(colon + 1));
    if (!Number.isInteger(id)) return null;
    return { kind: text.slice(0, colon), id };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- schema

type TypeRef =
  | { kind: 'named'; name: string }
  | { kind: 'list'; ofType: TypeRef }
  | { kind: 'nonNull'; ofType: TypeRef };

const typeRefCache = new Map<string, TypeRef>();

function typeRef(dsl: string): TypeRef {
  const cached = typeRefCache.get(dsl);
  if (cached !== undefined) return cached;
  let index = 0;
  const parse = (): TypeRef => {
    let ref: TypeRef;
    if (dsl[index] === '[') {
      index += 1;
      const inner = parse();
      index += 1; // ']'
      ref = { kind: 'list', ofType: inner };
    } else {
      const start = index;
      while (index < dsl.length && /[A-Za-z0-9_]/.test(dsl[index]!)) index += 1;
      ref = { kind: 'named', name: dsl.slice(start, index) };
    }
    if (dsl[index] === '!') {
      index += 1;
      ref = { kind: 'nonNull', ofType: ref };
    }
    return ref;
  };
  const ref = parse();
  typeRefCache.set(dsl, ref);
  return ref;
}

interface FieldDef {
  type: string;
  args?: Record<string, string>;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
  inputFields?: Record<string, string>;
}

const SCHEMA: Record<string, TypeDef> = {
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Float: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  GitObjectID: { kind: 'SCALAR' },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  FileChangeType: { kind: 'ENUM', enumValues: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'CHANGED'] },
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User!' },
      repository: { type: 'Repository', args: { owner: 'String!', name: 'String!' } },
      node: { type: 'Node', args: { id: 'ID!' } },
      search: { type: 'SearchResultItemConnection!', args: { query: 'String!', type: 'SearchType!', first: 'Int', after: 'String' } },
      __type: { type: '__Type', args: { name: 'String!' } },
      __schema: { type: '__Schema' },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: { type: 'CreateIssuePayload', args: { input: 'CreateIssueInput!' } },
      closeIssue: { type: 'CloseIssuePayload', args: { input: 'CloseIssueInput!' } },
      createPullRequest: { type: 'CreatePullRequestPayload', args: { input: 'CreatePullRequestInput!' } },
      mergePullRequest: { type: 'MergePullRequestPayload', args: { input: 'MergePullRequestInput!' } },
      addComment: { type: 'AddCommentPayload', args: { input: 'AddCommentInput!' } },
    },
  },
  Node: { kind: 'OBJECT', fields: { id: { type: 'ID!' } } },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      login: { type: 'String!' },
      name: { type: 'String' },
      email: { type: 'String' },
      url: { type: 'URI' },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      databaseId: { type: 'Int' },
      name: { type: 'String!' },
      nameWithOwner: { type: 'String!' },
      owner: { type: 'User!' },
      description: { type: 'String' },
      isPrivate: { type: 'Boolean!' },
      viewerPermission: { type: 'RepositoryPermission' },
      hasIssuesEnabled: { type: 'Boolean!' },
      defaultBranchRef: { type: 'Ref' },
      issue: { type: 'Issue', args: { number: 'Int!' } },
      issues: {
        type: 'IssueConnection!',
        args: { first: 'Int', after: 'String', last: 'Int', before: 'String', states: '[IssueState!]', orderBy: 'IssueOrder' },
      },
      pullRequest: { type: 'PullRequest', args: { number: 'Int!' } },
      pullRequests: { type: 'PullRequestConnection!', args: { first: 'Int', after: 'String', states: '[PullRequestState!]' } },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      url: { type: 'URI!' },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      prefix: { type: 'String!' },
      target: { type: 'Commit' },
    },
  },
  Commit: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      oid: { type: 'GitObjectID!' },
      message: { type: 'String' },
      committedDate: { type: 'DateTime' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'IssueState!' },
      author: { type: 'User' },
      repository: { type: 'Repository!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      closedAt: { type: 'DateTime' },
      url: { type: 'URI!' },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      number: { type: 'Int!' },
      title: { type: 'String!' },
      body: { type: 'String' },
      state: { type: 'PullRequestState!' },
      merged: { type: 'Boolean!' },
      mergedAt: { type: 'DateTime' },
      mergeable: { type: 'MergeableState!' },
      headRefName: { type: 'String!' },
      baseRefName: { type: 'String!' },
      headRef: { type: 'Ref' },
      baseRef: { type: 'Ref' },
      files: { type: 'PullRequestChangedFileConnection', args: { first: 'Int', after: 'String' } },
      author: { type: 'User' },
      repository: { type: 'Repository!' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
      closedAt: { type: 'DateTime' },
      url: { type: 'URI!' },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String!' },
      additions: { type: 'Int!' },
      deletions: { type: 'Int!' },
      changeType: { type: 'FileChangeType!' },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean!' },
      hasPreviousPage: { type: 'Boolean!' },
      startCursor: { type: 'String' },
      endCursor: { type: 'String' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]' },
      edges: { type: '[IssueEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  IssueEdge: { kind: 'OBJECT', fields: { node: { type: 'Issue' }, cursor: { type: 'String!' } } },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]' },
      edges: { type: '[PullRequestEdge]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  PullRequestEdge: { kind: 'OBJECT', fields: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } } },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]' },
      pageInfo: { type: 'PageInfo!' },
      totalCount: { type: 'Int!' },
    },
  },
  SearchResultItemConnection: {
    kind: 'OBJECT',
    fields: {
      issueCount: { type: 'Int!' },
      repositoryCount: { type: 'Int!' },
      userCount: { type: 'Int!' },
      nodes: { type: '[Node]' },
      pageInfo: { type: 'PageInfo!' },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID!' },
      body: { type: 'String!' },
      author: { type: 'User' },
      createdAt: { type: 'DateTime!' },
      updatedAt: { type: 'DateTime!' },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' } },
  },
  IssueCommentEdge: {
    kind: 'OBJECT',
    fields: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } },
  },
  CreateIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { repositoryId: 'ID!', title: 'String!', body: 'String', clientMutationId: 'String' },
  },
  CloseIssueInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { issueId: 'ID!', stateReason: 'String', clientMutationId: 'String' },
  },
  CreatePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      repositoryId: 'ID!',
      baseRefName: 'String!',
      headRefName: 'String!',
      title: 'String!',
      body: 'String',
      draft: 'Boolean',
      clientMutationId: 'String',
    },
  },
  MergePullRequestInput: {
    kind: 'INPUT_OBJECT',
    inputFields: {
      pullRequestId: 'ID!',
      mergeMethod: 'PullRequestMergeMethod',
      commitHeadline: 'String',
      commitBody: 'String',
      clientMutationId: 'String',
    },
  },
  AddCommentInput: {
    kind: 'INPUT_OBJECT',
    inputFields: { subjectId: 'ID!', body: 'String!', clientMutationId: 'String' },
  },
  IssueOrder: {
    kind: 'INPUT_OBJECT',
    inputFields: { field: 'IssueOrderField', direction: 'OrderDirection' },
  },
  __Type: {
    kind: 'OBJECT',
    fields: {
      kind: { type: 'String!' },
      name: { type: 'String' },
      description: { type: 'String' },
      fields: { type: '[__Field]', args: { includeDeprecated: 'Boolean' } },
      enumValues: { type: '[__EnumValue]', args: { includeDeprecated: 'Boolean' } },
      possibleTypes: { type: '[__Type]' },
      inputFields: { type: '[__InputValue]' },
      interfaces: { type: '[__Type]' },
      ofType: { type: '__Type' },
    },
  },
  __Field: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      args: { type: '[__InputValue]' },
      type: { type: '__Type!' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __EnumValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      isDeprecated: { type: 'Boolean!' },
      deprecationReason: { type: 'String' },
    },
  },
  __InputValue: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      type: { type: '__Type!' },
      defaultValue: { type: 'String' },
    },
  },
  __Schema: {
    kind: 'OBJECT',
    fields: {
      types: { type: '[__Type!]!' },
      queryType: { type: '__Type!' },
      mutationType: { type: '__Type' },
      directives: { type: '[__Directive!]!' },
    },
  },
  __Directive: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String!' },
      description: { type: 'String' },
      locations: { type: '[String!]!' },
      args: { type: '[__InputValue!]!' },
    },
  },
};

// -------------------------------------------------------------------- parser

type AstValue =
  | { kind: 'string' | 'int' | 'float' | 'boolean' | 'enum'; value: string | number | boolean }
  | { kind: 'null' }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: AstValue[] }
  | { kind: 'object'; fields: Record<string, AstValue> };

interface AstField {
  name: string;
  alias: string | null;
  args: Record<string, AstValue>;
  selectionSet: AstSelection[] | null;
}

type AstSelection =
  | { kind: 'field'; field: AstField }
  | { kind: 'inline'; typeCondition: string | null; selectionSet: AstSelection[] }
  | { kind: 'spread'; name: string };

interface AstOperation {
  operation: 'query' | 'mutation';
  name: string | null;
  selectionSet: AstSelection[];
}

interface AstDocument {
  operations: AstOperation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: AstSelection[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:$@=!|'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === '/' ? '/' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j]!)) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character "${ch}" in query`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of query');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected "${token}", found "${got}"`);
  }

  private skipBalanced(): void {
    // Consume a parenthesized group (variable definitions, directives).
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(') depth += 1;
      else if (token === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.skipBalanced();
    }
  }

  parseDocument(): AstDocument {
    const operations: AstOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: AstSelection[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ operation: 'query', name: null, selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const operation = this.next() as 'query' | 'mutation';
        let name: string | null = null;
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.skipBalanced();
        this.skipDirectives();
        operations.push({ operation, name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token "${head}"`);
      }
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): AstSelection[] {
    this.expect('{');
    const selections: AstSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === undefined) throw new Error('unterminated selection set');
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expect('}');
    return selections;
  }

  private parseField(): AstField {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, AstValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    this.skipDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { name, alias, args, selectionSet };
  }

  private parseValue(): AstValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: AstValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, AstValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

// ------------------------------------------------------------------ executor

class GqlError extends Error {}

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: AstDocument['fragments'];
  errors: { message: string; path?: (string | number)[] }[];
}

type Source = Record<string, unknown> & { __typename: string };

function viewerSource(): Source {
  return {
    __typename: 'User',
    id: encodeNodeId('User', VIEWER_ID),
    login: VIEWER_LOGIN,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    url: `https://forge.invalid/${VIEWER_LOGIN}`,
  };
}

function repoSource(forge: Forge, repo: RepoRec): Source {
  return {
    __typename: 'Repository',
    id: encodeNodeId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${VIEWER_LOGIN}/${repo.name}`,
    description: repo.description === '' ? null : repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: forge.iso(repo.createdAt),
    updatedAt: forge.iso(repo.updatedAt),
    url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}`,
    _repo: repo,
  };
}

function issueSource(forge: Forge, repo: RepoRec, issue: IssueRec): Source {
  return {
    __typename: 'Issue',
    id: encodeNodeId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state.toUpperCase(),
    createdAt: forge.iso(issue.createdAt),
    updatedAt: forge.iso(issue.updatedAt),
    closedAt: issue.closedAt === null ? null : forge.iso(issue.closedAt),
    url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    _repo: repo,
    _issue: issue,
  };
}

function pullState(pull: PullRec): string {
  return pull.merged ? 'MERGED' : pull.state.toUpperCase();
}

function pullSource(forge: Forge, repo: RepoRec, pull: PullRec): Source {
  return {
    __typename: 'PullRequest',
    id: encodeNodeId('PullRequest', pull.id),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    merged: pull.merged,
    mergedAt: pull.mergedAt === null ? null : forge.iso(pull.mergedAt),
    createdAt: forge.iso(pull.createdAt),
    updatedAt: forge.iso(pull.updatedAt),
    closedAt: pull.closedAt === null ? null : forge.iso(pull.closedAt),
    url: `https://forge.invalid/${VIEWER_LOGIN}/${repo.name}/pull/${pull.number}`,
    _repo: repo,
    _pull: pull,
  };
}

function commentSource(forge: Forge, repo: RepoRec, comment: { id: number; body: string; createdAt: number; updatedAt: number }): Source {
  void repo;
  return {
    __typename: 'IssueComment',
    id: encodeNodeId('IssueComment', comment.id),
    body: comment.body,
    createdAt: forge.iso(comment.createdAt),
    updatedAt: forge.iso(comment.updatedAt),
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string): number {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionSpec<T> {
  typename: string;
  items: T[];
  first: number | null;
  after: string | null;
}

function connectionSource<T extends Source>(spec: ConnectionSpec<T>): Source {
  const start = spec.after === null ? 0 : indexFromCursor(spec.after) + 1;
  const limit = spec.first === null ? spec.items.length : Math.max(0, spec.first);
  const page = spec.items.slice(start, start + limit);
  const hasNext = start + page.length < spec.items.length;
  const endCursor = page.length > 0 ? cursorFor(start + page.length - 1) : cursorFor(start - 1);
  return {
    __typename: spec.typename,
    totalCount: spec.items.length,
    _nodes: page,
    _edges: page.map((node, i) => ({ __typename: `${spec.typename.replace('Connection', '')}Edge`, node, cursor: cursorFor(start + i) })),
    _pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: hasNext,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? endCursor : null,
    } as Source,
  };
}

function typeObjectForName(name: string): Source | null {
  const def = SCHEMA[name];
  if (def === undefined) return null;
  return { __typename: '__Type', _name: name, _def: def, _ref: typeRef(name) };
}

function typeObjectForRef(ref: TypeRef): Source {
  if (ref.kind === 'named') return typeObjectForName(ref.name) ?? { __typename: '__Type', _name: ref.name, _def: undefined, _ref: ref };
  return { __typename: '__Type', _name: null, _def: undefined, _ref: ref };
}

function inputValueSource(name: string, dsl: string): Source {
  return { __typename: '__InputValue', name, description: null, defaultValue: null, _typeDsl: dsl };
}

type Resolver = (source: Source, args: Record<string, unknown>, ctx: Ctx) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerSource(),
    repository: (_source, args, ctx) => {
      if (args.owner !== VIEWER_LOGIN || typeof args.name !== 'string') return null;
      const repo = ctx.forge.getRepo(args.name);
      return repo === undefined ? null : repoSource(ctx.forge, repo);
    },
    node: (_source, args, ctx) => nodeById(ctx, String(args.id ?? '')),
    search: () => ({
      __typename: 'SearchResultItemConnection',
      issueCount: 0,
      repositoryCount: 0,
      userCount: 0,
      _nodes: [],
      _pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
    }),
    __type: (_source, args) => typeObjectForName(String(args.name ?? '')),
    __schema: () => ({ __typename: '__Schema' }),
  },
  Mutation: {
    createIssue: (_source, args, ctx) => {
      const input = asInput(args.input);
      const located = repoByNodeId(ctx, input.repositoryId);
      if (located === null) throw new GqlError('repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const issue = createIssueRecord(ctx.forge, located, { title, body: typeof input.body === 'string' ? input.body : '', labels: [] });
      return { __typename: 'CreateIssuePayload', issue: issueSource(ctx.forge, located, issue), clientMutationId: input.clientMutationId ?? null };
    },
    closeIssue: (_source, args, ctx) => {
      const input = asInput(args.input);
      const located = typeof input.issueId === 'string' ? ctx.forge.issueById.get(decodeNodeId(input.issueId)?.id ?? -1) : undefined;
      if (located === undefined) throw new GqlError('issueId does not name an issue');
      const ts = ctx.forge.tick();
      located.issue.state = 'closed';
      located.issue.closedAt = ts;
      located.issue.updatedAt = ts;
      return { __typename: 'CloseIssuePayload', issue: issueSource(ctx.forge, located.repo, located.issue), clientMutationId: input.clientMutationId ?? null };
    },
    createPullRequest: (_source, args, ctx) => {
      const input = asInput(args.input);
      const repo = repoByNodeId(ctx, input.repositoryId);
      if (repo === null) throw new GqlError('repositoryId does not name a repository');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlError('title is required');
      const error = pullValidationError(ctx.forge, repo, head, base);
      if (error !== null) throw new GqlError(error);
      const pull = createPullRecord(ctx.forge, repo, { title, body: typeof input.body === 'string' ? input.body : '', head, base });
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(ctx.forge, repo, pull), clientMutationId: input.clientMutationId ?? null };
    },
    mergePullRequest: (_source, args, ctx) => {
      const input = asInput(args.input);
      const located = typeof input.pullRequestId === 'string' ? ctx.forge.pullById.get(decodeNodeId(input.pullRequestId)?.id ?? -1) : undefined;
      if (located === undefined) throw new GqlError('pullRequestId does not name a pull request');
      const methodRaw = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
      const method = methodRaw === 'merge' ? 'merge' : methodRaw === 'rebase' ? 'rebase' : 'squash';
      const result = mergePull(
        ctx.forge,
        located.repo,
        located.pull,
        method,
        typeof input.commitHeadline === 'string' ? input.commitHeadline : undefined,
        typeof input.commitBody === 'string' ? input.commitBody : undefined,
      );
      if (!result.ok) throw new GqlError('Pull Request is not mergeable');
      return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(ctx.forge, located.repo, located.pull), clientMutationId: input.clientMutationId ?? null };
    },
    addComment: (_source, args, ctx) => {
      const input = asInput(args.input);
      const body = typeof input.body === 'string' ? input.body : '';
      const decoded = typeof input.subjectId === 'string' ? decodeNodeId(input.subjectId) : null;
      if (decoded === null) throw new GqlError('subjectId is not a valid node id');
      const holder =
        decoded.kind === 'Issue'
          ? ctx.forge.issueById.get(decoded.id)
          : decoded.kind === 'PullRequest'
            ? ctx.forge.pullById.get(decoded.id)
            : undefined;
      if (holder === undefined) throw new GqlError('subjectId does not name an issue or pull request');
      const target = 'issue' in holder ? holder.issue : holder.pull;
      const ts = ctx.forge.tick();
      const comment = { id: ctx.forge.nextId(), body, user: VIEWER_LOGIN, createdAt: ts, updatedAt: ts };
      target.comments.push(comment);
      ctx.forge.commentById.set(comment.id, { repo: holder.repo, comment });
      const node = commentSource(ctx.forge, holder.repo, comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorFor(0) },
        clientMutationId: input.clientMutationId ?? null,
      };
    },
  },
  Repository: {
    owner: () => viewerSource(),
    defaultBranchRef: (source, _args, ctx) => {
      const repo = source._repo as RepoRec;
      const tip = ctx.forge.branchTip(repo, repo.defaultBranch);
      return {
        __typename: 'Ref',
        name: repo.defaultBranch,
        prefix: 'refs/heads/',
        target:
          tip === undefined
            ? null
            : { __typename: 'Commit', id: tip, oid: tip, message: null, committedDate: null },
      };
    },
    issue: (source, args, ctx) => {
      const repo = source._repo as RepoRec;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueSource(ctx.forge, repo, issue);
    },
    issues: (source, args, ctx) => {
      const repo = source._repo as RepoRec;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      if (orderBy !== null && orderBy.field === 'CREATED_AT') {
        const dir = orderBy.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => dir * (a.createdAt - b.createdAt || a.number - b.number));
      } else if (orderBy !== null && orderBy.field === 'UPDATED_AT') {
        const dir = orderBy.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => dir * (a.updatedAt - b.updatedAt || a.number - b.number));
      } else {
        issues.sort((a, b) => a.number - b.number);
      }
      return connectionSource({
        typename: 'IssueConnection',
        items: issues.map((issue) => issueSource(ctx.forge, repo, issue)),
        first: typeof args.first === 'number' ? args.first : null,
        after: typeof args.after === 'string' ? args.after : null,
      });
    },
    pullRequest: (source, args, ctx) => {
      const repo = source._repo as RepoRec;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullSource(ctx.forge, repo, pull);
    },
    pullRequests: (source, args, ctx) => {
      const repo = source._repo as RepoRec;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      pulls.sort((a, b) => a.number - b.number);
      return connectionSource({
        typename: 'PullRequestConnection',
        items: pulls.map((pull) => pullSource(ctx.forge, repo, pull)),
        first: typeof args.first === 'number' ? args.first : null,
        after: typeof args.after === 'string' ? args.after : null,
      });
    },
  },
  PullRequest: {
    author: () => viewerSource(),
    repository: (source, _args, ctx) => repoSource(ctx.forge, source._repo as RepoRec),
    headRefName: (source) => (source._pull as PullRec).headRef,
    baseRefName: (source) => (source._pull as PullRec).baseRef,
    headRef: (source) => ({ __typename: 'Ref', name: (source._pull as PullRec).headRef, prefix: 'refs/heads/', target: null }),
    baseRef: (source) => ({ __typename: 'Ref', name: (source._pull as PullRec).baseRef, prefix: 'refs/heads/', target: null }),
    mergeable: (source, _args, ctx) => {
      const repo = source._repo as RepoRec;
      const pull = source._pull as PullRec;
      if (pull.merged) return 'UNKNOWN';
      const headTip = ctx.forge.branchTip(repo, pull.headRef);
      const baseTip = ctx.forge.branchTip(repo, pull.baseRef);
      if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
      const mergeBase = ctx.forge.mergeBase(headTip, baseTip);
      const baseFlat = mergeBase === null ? new Map() : ctx.forge.flattenCommit(mergeBase);
      const result = ctx.forge.mergeFlats(baseFlat, ctx.forge.flattenCommit(baseTip), ctx.forge.flattenCommit(headTip));
      return result.ok ? 'MERGEABLE' : 'CONFLICTING';
    },
    files: (source, args, ctx) => {
      const repo = source._repo as RepoRec;
      const pull = source._pull as PullRec;
      const files = pullFiles(ctx.forge, repo, pull).map((file) => ({
        __typename: 'PullRequestChangedFile',
        path: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
      })) as Source[];
      return connectionSource({
        typename: 'PullRequestChangedFileConnection',
        items: files,
        first: typeof args.first === 'number' ? args.first : null,
        after: typeof args.after === 'string' ? args.after : null,
      });
    },
  },
  Issue: {
    author: () => viewerSource(),
    repository: (source, _args, ctx) => repoSource(ctx.forge, source._repo as RepoRec),
  },
  IssueComment: {
    author: () => viewerSource(),
  },
  IssueConnection: {
    nodes: (source) => source._nodes,
    edges: (source) => source._edges,
    pageInfo: (source) => source._pageInfo,
  },
  PullRequestConnection: {
    nodes: (source) => source._nodes,
    edges: (source) => source._edges,
    pageInfo: (source) => source._pageInfo,
  },
  PullRequestChangedFileConnection: {
    nodes: (source) => source._nodes,
    pageInfo: (source) => source._pageInfo,
  },
  SearchResultItemConnection: {
    nodes: (source) => source._nodes,
    pageInfo: (source) => source._pageInfo,
  },
  __Type: {
    kind: (source) => {
      const ref = source._ref as TypeRef;
      if (ref.kind === 'list') return 'LIST';
      if (ref.kind === 'nonNull') return 'NON_NULL';
      return (source._def as TypeDef | undefined)?.kind ?? 'OBJECT';
    },
    name: (source) => source._name,
    description: () => null,
    fields: (source) => {
      const def = source._def as TypeDef | undefined;
      if (def === undefined || def.fields === undefined) return null;
      return Object.entries(def.fields).map(([name, fieldDef]) => ({
        __typename: '__Field',
        name,
        description: null,
        isDeprecated: false,
        deprecationReason: null,
        _fieldDef: fieldDef,
      }));
    },
    enumValues: (source) => {
      const def = source._def as TypeDef | undefined;
      if (def === undefined || def.enumValues === undefined) return null;
      return def.enumValues.map((name) => ({ __typename: '__EnumValue', name, description: null, isDeprecated: false, deprecationReason: null }));
    },
    possibleTypes: () => null,
    inputFields: (source) => {
      const def = source._def as TypeDef | undefined;
      if (def === undefined || def.inputFields === undefined) return null;
      return Object.entries(def.inputFields).map(([name, dsl]) => inputValueSource(name, dsl));
    },
    interfaces: () => [],
    ofType: (source) => {
      const ref = source._ref as TypeRef;
      return ref.kind === 'named' ? null : typeObjectForRef(ref.ofType);
    },
  },
  __Field: {
    args: (source) => {
      const def = source._fieldDef as FieldDef;
      return Object.entries(def.args ?? {}).map(([name, dsl]) => inputValueSource(name, dsl));
    },
    type: (source) => typeObjectForRef(typeRef((source._fieldDef as FieldDef).type)),
  },
  __InputValue: {
    type: (source) => typeObjectForRef(typeRef(source._typeDsl as string)),
  },
  __Schema: {
    types: () => Object.keys(SCHEMA).map((name) => typeObjectForName(name)!),
    queryType: () => typeObjectForName('Query'),
    mutationType: () => typeObjectForName('Mutation'),
    directives: () => [],
  },
};

function asInput(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
}

function repoByNodeId(ctx: Ctx, raw: unknown): RepoRec | null {
  if (typeof raw !== 'string') return null;
  const decoded = decodeNodeId(raw);
  if (decoded === null || decoded.kind !== 'Repository') return null;
  return ctx.forge.repoById.get(decoded.id) ?? null;
}

function nodeById(ctx: Ctx, raw: string): Source | null {
  const decoded = decodeNodeId(raw);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = ctx.forge.repoById.get(decoded.id);
    return repo === undefined ? null : repoSource(ctx.forge, repo);
  }
  if (decoded.kind === 'Issue') {
    const located = ctx.forge.issueById.get(decoded.id);
    return located === undefined ? null : issueSource(ctx.forge, located.repo, located.issue);
  }
  if (decoded.kind === 'PullRequest') {
    const located = ctx.forge.pullById.get(decoded.id);
    return located === undefined ? null : pullSource(ctx.forge, located.repo, located.pull);
  }
  if (decoded.kind === 'IssueComment') {
    const located = ctx.forge.commentById.get(decoded.id);
    return located === undefined ? null : commentSource(ctx.forge, located.repo, located.comment);
  }
  if (decoded.kind === 'User' && decoded.id === VIEWER_ID) return viewerSource();
  return null;
}

function resolveValue(value: AstValue, ctx: Ctx): unknown {
  switch (value.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'variable':
      return ctx.variables[value.name];
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value.fields)) out[key] = resolveValue(inner, ctx);
      return out;
    }
  }
}

function executeSelectionSet(typeName: string, source: Source, selections: AstSelection[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline' || selection.kind === 'spread') {
      const fragment =
        selection.kind === 'inline'
          ? { typeCondition: selection.typeCondition, selectionSet: selection.selectionSet }
          : ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== null && fragment.typeCondition !== source.__typename && fragment.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(fragment.typeCondition ?? typeName, source, fragment.selectionSet, ctx, path));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const fieldDef = typeDef?.fields?.[field.name];
    if (fieldDef === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [argName, argValue] of Object.entries(field.args)) args[argName] = resolveValue(argValue, ctx);
    try {
      const resolver = RESOLVERS[typeName]?.[field.name];
      const raw = resolver !== undefined ? resolver(source, args, ctx) : source[field.name];
      out[key] = completeValue(typeRef(fieldDef.type), raw, field.selectionSet, ctx, [...path, key]);
    } catch (error) {
      if (error instanceof GqlError) {
        ctx.errors.push({ message: error.message, path: [...path, key] });
        out[key] = null;
      } else {
        throw error;
      }
    }
  }
  return out;
}

function completeValue(ref: TypeRef, raw: unknown, selectionSet: AstSelection[] | null, ctx: Ctx, path: (string | number)[]): unknown {
  if (ref.kind === 'nonNull') return completeValue(ref.ofType, raw, selectionSet, ctx, path);
  if (raw === null || raw === undefined) return null;
  if (ref.kind === 'list') {
    const items = Array.isArray(raw) ? raw : [raw];
    return items.map((item, index) => completeValue(ref.ofType, item, selectionSet, ctx, [...path, index]));
  }
  const def = SCHEMA[ref.name];
  if (def === undefined || def.kind === 'SCALAR' || def.kind === 'ENUM') {
    return ref.name === 'ID' ? String(raw) : raw;
  }
  const source = raw as Source;
  return executeSelectionSet(source.__typename ?? ref.name, source, selectionSet ?? [], ctx, path);
}

// ------------------------------------------------------------------ endpoint

export interface GraphQLRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export function executeGraphQL(forge: Forge, request: GraphQLRequest): Record<string, unknown> {
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'a query string is required' }] };
  }
  let document: AstDocument;
  try {
    document = new Parser(request.query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'could not parse the query' }] };
  }
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  const operation =
    operationName !== null
      ? document.operations.find((op) => op.name === operationName)
      : document.operations.length === 1
        ? document.operations[0]
        : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  const ctx: Ctx = {
    forge,
    variables: request.variables !== null && typeof request.variables === 'object' ? (request.variables as Record<string, unknown>) : {},
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const rootSource: Source = { __typename: rootType };
  const data = executeSelectionSet(rootType, rootSource, operation.selectionSet, ctx, []);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
