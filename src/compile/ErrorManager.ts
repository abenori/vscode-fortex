import * as vscode from 'vscode';

/** Owns the diagnostic collection populated from errors in the TeX log. */
export default class ErrorManager{
  private constructor(){}
  private static collection : vscode.DiagnosticCollection;
  static init(context: vscode.ExtensionContext){
    ErrorManager.collection = vscode.languages.createDiagnosticCollection("vscode-fortex");
    context.subscriptions.push(ErrorManager.collection);
  }
  static adderror(uri: vscode.Uri, range: vscode.Range, message: string){
    // DiagnosticCollection.set replaces all diagnostics for a URI, so retain the
    // previously parsed errors before adding the new one.
    let diagnostics : vscode.Diagnostic[]= [];
    if(ErrorManager.collection.get(uri)) { diagnostics = [...ErrorManager.collection.get(uri)!]; }
    diagnostics.push(new vscode.Diagnostic(range, message, vscode.DiagnosticSeverity.Error));
    ErrorManager.collection.set(uri, diagnostics);
  }
  static clear(){
    ErrorManager.collection.clear();
  }

}
