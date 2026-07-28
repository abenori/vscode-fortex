import * as vscode from 'vscode';

export default class ErrorManager{
  private constructor(){}
  private static collection : vscode.DiagnosticCollection;
  static init(context: vscode.ExtensionContext){
    ErrorManager.collection = vscode.languages.createDiagnosticCollection("vscode-fortex");
    context.subscriptions.push(ErrorManager.collection);
  }
  static adderror(uri: vscode.Uri, range: vscode.Range, message: string){
    let diagnostics : vscode.Diagnostic[]= [];
    if(ErrorManager.collection.get(uri)) { diagnostics = [...ErrorManager.collection.get(uri)!]; }
    diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
    ErrorManager.collection.set(uri, diagnostics);
  }
  static clear(){
    ErrorManager.collection.clear()
  }

}