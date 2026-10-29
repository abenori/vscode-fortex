/** Shared declaration names; consumers retain their own parsing rules. */
export const CLASSIC_COMMAND_DECLARATIONS = [
  'newcommand', 'renewcommand', 'providecommand', 'DeclareRobustCommand'
] as const;

export const CLASSIC_ENVIRONMENT_DECLARATIONS = [
  'newenvironment', 'renewenvironment', 'provideenvironment'
] as const;

export const DOCUMENT_COMMAND_DECLARATIONS = [
  'NewDocumentCommand', 'RenewDocumentCommand', 'ProvideDocumentCommand', 'DeclareDocumentCommand',
  'NewExpandableDocumentCommand', 'RenewExpandableDocumentCommand',
  'ProvideExpandableDocumentCommand', 'DeclareExpandableDocumentCommand'
] as const;

export const DOCUMENT_ENVIRONMENT_DECLARATIONS = [
  'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'ProvideDocumentEnvironment', 'DeclareDocumentEnvironment'
] as const;

export const PRIMITIVE_COMMAND_DECLARATIONS = ['def', 'gdef', 'edef', 'xdef'] as const;
