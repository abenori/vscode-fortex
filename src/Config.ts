import * as vscode from 'vscode';

export default class Config {
  static readonly config_name = "vscode-fortex";
  static get<T>(key: string, default_value: T) : T {
    return vscode.workspace.getConfiguration(Config.config_name).get<T>(key, default_value);
  }

  public static mainFileOrder(){
    return Config.get<string[]>("mainFileOrder", ["magic", "guess", "current"]);
  }

  public static compileTrigger(){
    return Config.get<string[]>("compileTrigger", ["onSave"]);
  }

  public static pdfViewer(): "internal" | "sumatra" {
    return Config.get<"internal" | "sumatra">("pdfViewer", "internal");
  }

  public static openPdfAfterBuild(): boolean {
    return Config.get<boolean>("openPdfAfterBuild", false);
  }

  public static sumatraPDFPath(): string {
    return Config.get<string>("sumatraPDF.path", "");
  }

  public static sumatraPDFArgs(): string[] {
    return Config.get<string[]>("sumatraPDF.args", ["-reuse-instance"]);
  }

  public static sumatraPDFInverseSearchEnabled(): boolean {
    return Config.get<boolean>("sumatraPDF.inverseSearch.enabled", true);
  }

  public static sumatraPDFInverseSearchVSCodePath(): string {
    return Config.get<string>("sumatraPDF.inverseSearch.vscodePath", "");
  }

  public static syncTeXPath(): string {
    return Config.get<string>("synctex.path", "synctex");
  }

  public static syncTeXForwardSearchFocus(): "editor" | "viewer" {
    return Config.get<"editor" | "viewer">("synctex.forwardSearch.focus", "editor");
  }

  public static kpsewhichPath(): string {
    return Config.get<string>("kpsewhich.path", "kpsewhich");
  }

}
